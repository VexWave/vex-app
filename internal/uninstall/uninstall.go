package uninstall

import (
	"crypto/rand"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/VexWave/vex-app/internal/buildinfo"
	"github.com/VexWave/vex-app/internal/busy"
	"github.com/VexWave/vex-app/internal/datadirs"
	"github.com/VexWave/vex-app/internal/platform"
	"golang.org/x/sys/windows/registry"
)

const (
	quitDelay = 500 * time.Millisecond
	exitWait  = 2 * time.Minute
)

func InstallDir() (string, bool) {
	exe, err := os.Executable()
	if err != nil {
		return "", false
	}
	return installDir(registry.CURRENT_USER, datadirs.UninstallPath, buildinfo.UninstallKeys[buildinfo.Channel], exe)
}

func installDir(base registry.Key, path, key, exe string) (string, bool) {
	if key == "" {
		return "", false
	}
	s, err := datadirs.UninstallString(base, path, key)
	if err != nil || s == "" {
		return "", false
	}
	dir := filepath.Dir(strings.Trim(s, `"`))
	rel, err := filepath.Rel(dir, exe)
	if err != nil || rel == ".." || strings.HasPrefix(rel, `..\`) || filepath.IsAbs(rel) {
		return "", false
	}
	return dir, true
}

type UninstallService struct {
	Busy *busy.Registry
	Quit func()
}

type Target struct {
	Removable bool `json:"removable"`
}

func (s *UninstallService) Removable() Target {
	_, ok := InstallDir()
	return Target{ok}
}

func (s *UninstallService) Start() error {
	if reason := s.Busy.QuitBlocker(); reason != "" {
		return errors.New(reason)
	}
	dir, ok := InstallDir()
	if !ok {
		return errors.New("VexWave can only uninstall an installed copy of itself, and this one is running from a development build.")
	}
	// ponytail: the helper copy stays in %TEMP%, since a running exe can't delete itself; Windows' temp cleanup takes it.
	helper, err := platform.CopySelf(filepath.Join(os.TempDir(), "vexwave-uninstall-"+rand.Text()+".exe"))
	if err != nil {
		return errors.New("The uninstaller couldn't start, so nothing was removed.")
	}
	if err := platform.SpawnDetached(exec.Command(helper, "--uninstall-helper", strconv.Itoa(os.Getpid()), dir)); err != nil {
		os.Remove(helper)
		return errors.New("The uninstaller couldn't start, so nothing was removed.")
	}
	time.AfterFunc(quitDelay, s.Quit)
	return nil
}

func Helper(pid, dir string) error {
	if err := platform.WaitExit(pid, exitWait); err != nil {
		return err
	}
	return exec.Command(filepath.Join(dir, "uninstall.exe"), "/S").Run()
}

func RemoveData() error {
	var others []string
	for ch, key := range buildinfo.UninstallKeys {
		if ch != buildinfo.Channel {
			others = append(others, key)
		}
	}
	return datadirs.Default().RemoveData(buildinfo.Channel, others, func(key string) (bool, error) {
		return datadirs.Installed(registry.CURRENT_USER, datadirs.UninstallPath, key)
	})
}
