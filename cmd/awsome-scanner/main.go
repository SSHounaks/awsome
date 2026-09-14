package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"awsome/internal/collect"
	"awsome/internal/config"
	"awsome/internal/inspect"
	"awsome/internal/model"
)

func main() {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	snapshotID := cfg.SnapshotID
	if snapshotID == "" {
		snapshotID = "snap-" + time.Now().UTC().Format("20060102T150405Z")
	}

	target, err := collect.ResolveTarget(ctx, cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "resolve target:", err)
		os.Exit(1)
	}

	dir := filepath.Join(cfg.SnapshotDir, snapshotID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "mkdir:", err)
		os.Exit(1)
	}

	emit := collect.NewEmitter(1024)
	startedAt := model.Now()
	status := "completed"

	recordsPath := filepath.Join(dir, "records.jsonl")
	statsCh := make(chan map[string]int, 1)
	writeErrCh := make(chan error, 1)
	go func() {
		stats, werr := inspect.WriteRecords(recordsPath, emit.Chan())
		statsCh <- stats
		writeErrCh <- werr
	}()

	runErr := collect.Run(ctx, cfg, target, snapshotID, emit)
	emit.Close()
	stats := <-statsCh
	writeErr := <-writeErrCh

	if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		status = "interrupted"
	} else if runErr != nil {
		status = "partial"
	}

	snapshot := collect.MakeSnapshot(snapshotID, target.AccountID, target.Partition, target.Regions, startedAt, status)
	snapshot.FinishedAt = model.Now()
	snapshot.Statistics = stats
	if err := inspect.WriteJSON(filepath.Join(dir, "summary.json"), snapshot); err != nil {
		fmt.Fprintln(os.Stderr, "summary:", err)
	}

	fmt.Printf("snapshot  %s (%s)\n", snapshotID, status)
	fmt.Printf("account   %s partition %s\n", target.AccountID, target.Partition)
	fmt.Printf("regions   %v\n", target.Regions)
	fmt.Printf("records   %s\n", recordsPath)
	for k, v := range stats {
		fmt.Printf("  %-20s %d\n", k, v)
	}

	if writeErr != nil {
		fmt.Fprintln(os.Stderr, "write records:", writeErr)
		os.Exit(1)
	}
	var exitErr error
	if runErr != nil {
		fmt.Fprintln(os.Stderr, "collection errors:")
		exitErr = runErr
		if list, ok := runErr.(interface{ Unwrap() []error }); ok {
			for _, e := range list.Unwrap() {
				fmt.Fprintln(os.Stderr, "  -", e)
			}
		} else {
			fmt.Fprintln(os.Stderr, "  -", runErr)
		}
	}
	if exitErr != nil {
		os.Exit(1)
	}
}
