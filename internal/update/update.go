package update

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/VexWave/vex-app/internal/busy"
	"github.com/VexWave/vex-app/internal/netx"
	"github.com/VexWave/vex-app/internal/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

const (
	repository     = "VexWave/vex-app"
	installerAsset = "VexWave-installer.exe"
	installWait    = 5 * time.Minute
)

func Configure(u *updater.Updater, version string, proxy func() string) error {
	return configure(u, version, github.Config{
		Repository:    repository,
		ChecksumAsset: "SHA256SUMS",
		HTTPClient:    &http.Client{Transport: proxied(proxy)},
	})
}

func configure(u *updater.Updater, version string, gc github.Config) error {
	gc.AssetMatcher = pickInstaller
	gh, err := github.New(gc)
	if err != nil {
		return err
	}
	return u.Init(updater.Config{CurrentVersion: version, Providers: []updater.Provider{gh}, Window: updater.WindowNone})
}

func pickInstaller(_ updater.CheckRequest, assets []github.ReleaseAsset) int {
	for i, a := range assets {
		if a.Name == installerAsset {
			return i
		}
	}
	return -1
}

type proxied func() string

func (p proxied) RoundTrip(r *http.Request) (*http.Response, error) {
	return netx.For(p()).Stream.Transport.RoundTrip(r)
}

type UpdateService struct {
	Updater    *updater.Updater
	Busy       *busy.Registry
	InstallDir func() (string, bool)
	Quit       func()

	ctx         context.Context
	mu          sync.Mutex
	latest      string
	downloading bool
	handedOff   bool
}

func (s *UpdateService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	s.ctx = ctx
	if exe, err := os.Executable(); err == nil {
		sweep(exe)
	}
	return nil
}

// Wails' updater clears a staged download only on the next download. SingleInstance has exited a
// second launch before this runs.
func sweep(exe string) {
	stale, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), "wails-update-*"))
	for _, p := range append(stale, platform.HelperCopies()...) {
		os.RemoveAll(p)
	}
}

type Available struct {
	LatestVersion string `json:"latestVersion,omitempty"`
}

func (s *UpdateService) Check(ctx context.Context) Available {
	if s.Updater == nil {
		return Available{}
	}
	rel, err := s.Updater.Check(ctx)
	if err != nil || rel == nil {
		return Available{}
	}
	s.mu.Lock()
	s.latest = rel.Version
	s.mu.Unlock()
	return Available{rel.Version}
}

func (s *UpdateService) Download() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.latest == "":
		return errors.New("There is no update to download.")
	case s.downloading:
		return errors.New("The update is already downloading.")
	}
	release, err := s.Busy.Acquire(busy.AppDownload)
	if err != nil {
		return err
	}
	s.downloading = true
	go func() {
		defer release()
		s.Updater.DownloadAndInstall(s.ctx)
		s.mu.Lock()
		s.downloading = false
		s.mu.Unlock()
	}()
	return nil
}

type Refusal struct {
	Message         string `json:"error"`
	DownloadMissing bool   `json:"downloadMissing,omitempty"`
}

func (r *Refusal) Error() string { return r.Message }

func (s *UpdateService) Install(ctx context.Context) error {
	if reason := s.Busy.QuitBlocker(); reason != "" {
		return &Refusal{Message: reason}
	}
	path := ""
	if s.Updater != nil {
		path = s.Updater.DownloadedPath()
	}
	if _, err := os.Stat(path); path == "" || err != nil {
		return &Refusal{Message: "The downloaded update is gone — download it again.", DownloadMissing: true}
	}
	if _, ok := s.InstallDir(); !ok {
		return &Refusal{Message: "Only an installed copy of VexWave can update itself."}
	}
	exe, err := os.Executable()
	if err != nil {
		return &Refusal{Message: "The update couldn't start: " + err.Error()}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handedOff {
		return &Refusal{Message: "The update is already installing."}
	}
	if err := platform.HandOff("--update-helper", s.Quit, path, exe); err != nil {
		return &Refusal{Message: "The update couldn't start: " + err.Error()}
	}
	s.handedOff = true
	return nil
}

func Helper(pid, installer, exe string) error {
	if err := platform.WaitExit(pid); err != nil {
		return err
	}
	installErr := install(installer, exe)
	// No HideWindow: SW_HIDE in STARTUPINFO would apply to the app's first ShowWindow.
	app := exec.Command(exe)
	if err := app.Start(); err != nil {
		return errors.Join(installErr, err)
	}
	app.Process.Release()
	return installErr
}

func install(installer, exe string) error {
	backup := exe + ".old"
	os.Remove(backup)
	if err := platform.CopyFile(exe, backup); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), installWait)
	defer cancel()
	cmd := exec.CommandContext(ctx, installer)
	// NSIS reads /D= only as the last argument and unquoted, even with spaces, which exec's quoting breaks.
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `"` + installer + `" /S /D=` + filepath.Dir(exe)}
	if err := cmd.Run(); err != nil {
		return errors.Join(err, os.Rename(backup, exe))
	}
	return os.Remove(backup)
}
