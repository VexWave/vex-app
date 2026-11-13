package platform

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func Command(ctx context.Context, bin, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	// exec keeps the last of case-insensitively equal keys on Windows, so this wins over an inherited Path=.
	cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return cmd
}

func CopySelf(dst string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	in, err := os.Open(exe)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return "", err
	}
	return dst, out.Close()
}

// A job that forbids breakaway refuses the flag, so it retries without.
func SpawnDetached(cmd *exec.Cmd) error {
	const flags = windows.DETACHED_PROCESS | windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags | windows.CREATE_BREAKAWAY_FROM_JOB}
	err := cmd.Start()
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		retry := exec.Command(cmd.Path, cmd.Args[1:]...)
		retry.Env, retry.Dir = cmd.Env, cmd.Dir
		retry.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
		cmd, err = retry, retry.Start()
	}
	if err != nil {
		return err
	}
	return cmd.Process.Release()
}

func WaitExit(pid string, timeout time.Duration) error {
	n, err := strconv.ParseUint(pid, 10, 32)
	if err != nil {
		return err
	}
	if h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(n)); err == nil {
		windows.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
		windows.CloseHandle(h)
	}
	return nil
}
