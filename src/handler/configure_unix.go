//go:build !windows

package main

import (
	"os/exec"
)

func configureWindowsCommand(cmd *exec.Cmd) {
	// No-op on non-Windows
}
