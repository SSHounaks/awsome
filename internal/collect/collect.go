package collect

import (
	"context"
	"errors"
	"os"
	os_user "os/user"
	"strings"
	"sync"

	"awsome/internal/config"
	"awsome/internal/model"
)

func Run(ctx context.Context, cfg config.Config, target Target, snapshotID string, emit *Emitter) error {
	steps := Plan(target)
	return runSteps(ctx, cfg, steps, snapshotID, emit)
}

func runSteps(ctx context.Context, cfg config.Config, steps []Step, snapshotID string, emit *Emitter) error {
	sem := make(chan struct{}, cfg.Concurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var errs []error
	for _, step := range steps {
		step := step
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			if err := RunStep(ctx, cfg, step, snapshotID, emit); err != nil {
				if !IsDegrade(err) {
					mu.Lock()
					errs = append(errs, err)
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	return errors.Join(errs...)
}

func IsDegrade(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, s := range []string{
		"not yet implemented",
		"NotImplemented",
		"InvalidAction",
		"OptInRequired",
		"AccessDenied",
		"UnauthorizedOperation",
	} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

func MakeSnapshot(snapshotID, accountID, partition string, regions []string, startedAt string, status string) model.Snapshot {
	user, host := owner()
	return model.Snapshot{
		Kind:       "snapshot",
		SnapshotID: snapshotID,
		AccountID:  accountID,
		Partition:  partition,
		StartedAt:  startedAt,
		Status:     status,
		Regions:    regions,
		User:       user,
		Hostname:   host,
		Statistics: map[string]int{},
	}
}

func owner() (string, string) {
	user := "unknown"
	if u, err := os_user.Current(); err == nil && u.Username != "" {
		user = u.Username
	}
	host, err := os.Hostname()
	if err != nil {
		host = "unknown"
	}
	return user, host
}
