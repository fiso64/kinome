//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func configureWindowsCommand(cmd *exec.Cmd) {
	// No-op on non-Windows
}

func configureUnixCommand(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	
	// Setsid creates a new session, detaching the process from the parent's terminal.
	// This prevents background UI players like mpv from getting EIO loops when
	// attempting to read from an orphaned /dev/tty.
	cmd.SysProcAttr.Setsid = true
}