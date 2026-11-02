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
	return runSteps(ctx, cfg, Plan(target), snapshotID, emit)
}

// RunAll scans every target into one snapshot. Steps from different accounts
// share the worker pool, so a slow account does not serialise the rest.
func RunAll(ctx context.Context, cfg config.Config, targets []Target, snapshotID string, emit *Emitter) error {
	return runSteps(ctx, cfg, PlanAll(targets), snapshotID, emit)
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
			err := RunStep(ctx, cfg, step, snapshotID, emit)
			emit.Send(coverageFor(step, snapshotID, err))
			if err != nil {
				if _, degraded := DegradeReason(err); !degraded {
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

// degradeMarkers are substrings that mean "this service can't answer here" —
// unimplemented (LocalStack), not available in this partition/region, or denied
// by the caller's policy. None of these invalidate the rest of the scan.
var degradeMarkers = []string{
	"not yet implemented",
	"NotImplemented",
	"InvalidAction",
	"OptInRequired",
	"AccessDenied",
	"UnauthorizedOperation",
	"InvalidClientTokenId",
	"UnrecognizedClientException",
	"EndpointConnectionError",
	"no such host",
}

// DegradeReason reports whether err is a tolerable "service unavailable to us"
// failure, and which marker matched so the snapshot can say why.
func DegradeReason(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	msg := err.Error()
	for _, s := range degradeMarkers {
		if strings.Contains(msg, s) {
			return s, true
		}
	}
	return "", false
}

func IsDegrade(err error) bool {
	_, ok := DegradeReason(err)
	return ok
}

func coverageFor(step Step, snapshotID string, err error) model.Coverage {
	c := model.Coverage{
		Kind:       "coverage",
		Service:    step.Service,
		Region:     step.Region,
		AccountID:  step.AccountID,
		Status:     "ok",
		SnapshotID: snapshotID,
		ScannedAt:  model.Now(),
	}
	if err != nil {
		c.Status = "failed"
		c.Error = truncate(err.Error(), 400)
		if reason, degraded := DegradeReason(err); degraded {
			c.Status = "degraded"
			c.Reason = reason
		}
	}
	return c
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// MakeSnapshotFor builds the snapshot record for a multi-account scan.
func MakeSnapshotFor(snapshotID string, targets []Target, startedAt, status string) model.Snapshot {
	var accounts, regions []string
	seenRegion := map[string]bool{}
	for _, t := range targets {
		accounts = append(accounts, t.AccountID)
		for _, r := range t.Regions {
			if !seenRegion[r] {
				seenRegion[r] = true
				regions = append(regions, r)
			}
		}
	}
	first := Target{}
	if len(targets) > 0 {
		first = targets[0]
	}
	s := MakeSnapshot(snapshotID, first.AccountID, first.Partition, regions, startedAt, status)
	s.Accounts = accounts
	return s
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
