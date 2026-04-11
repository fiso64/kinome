//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

func configureWindowsCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func configureUnixCommand(cmd *exec.Cmd) {
	// No-op on Windows
}