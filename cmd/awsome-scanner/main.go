package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"awsome/internal/collect"
	"awsome/internal/config"
	"awsome/internal/control"
	"awsome/internal/inspect"
	"awsome/internal/jobs"
)

func main() {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	if cfg.ControlAddr != "" {
		runServe(cfg)
		return
	}
	runOnce(cfg)
}

func runServe(cfg config.Config) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := os.MkdirAll(cfg.SnapshotDir, 0o755); err != nil {
		log.Fatalf("mkdir snapshot dir: %v", err)
	}
	store, err := jobs.OpenStore(filepath.Join(cfg.SnapshotDir, ".jobs.db"))
	if err != nil {
		log.Fatalf("open jobs store: %v", err)
	}
	bus := jobs.NewBus()
	mgr := jobs.NewManager(jobs.CfgFrom(cfg), store, bus)
	mgr.Restore()
	mgr.Start()
	defer mgr.Stop()

	if err := control.New(cfg.ControlAddr, cfg, mgr).ListenAndServe(ctx); err != nil {
		log.Fatalf("control: %v", err)
	}
	log.Println("scanner daemon stopped")
}

func runOnce(cfg config.Config) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	snapshotID := cfg.SnapshotID
	if snapshotID == "" {
		snapshotID = "snap-" + nowStamp()
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
	startedAt := modelNow()
	status := "completed"

	recordsPath := filepath.Join(dir, "records.jsonl")
	statsCh := make(chan map[string]int, 1)
	werrCh := make(chan error, 1)
	go func() {
		stats, werr := inspect.WriteRecords(recordsPath, emit.Chan())
		statsCh <- stats
		werrCh <- werr
	}()

	runErr := collect.Run(ctx, cfg, target, snapshotID, emit)
	emit.Close()

	stats := <-statsCh
	writeErr := <-werrCh

	if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		status = "interrupted"
	} else if runErr != nil {
		status = "partial"
	}

	snapshot := collect.MakeSnapshot(snapshotID, target.AccountID, target.Partition, target.Regions, startedAt, status)
	snapshot.FinishedAt = modelNow()
	snapshot.Trigger = "manual"
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
	if runErr != nil {
		fmt.Fprintln(os.Stderr, "collection errors:")
		if list, ok := runErr.(interface{ Unwrap() []error }); ok {
			for _, e := range list.Unwrap() {
				fmt.Fprintln(os.Stderr, "  -", e)
			}
		} else {
			fmt.Fprintln(os.Stderr, "  -", runErr)
		}
		os.Exit(1)
	}
}

func nowStamp() string {
	t := time.Now().UTC().Format("20060102T150405Z")
	return t
}

func modelNow() string {
	return time.Now().UTC().Format("20060102T150405Z")
}
