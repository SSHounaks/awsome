package collect

import (
	"context"
	"errors"
	"sync"

	"awsome/internal/config"
	"awsome/internal/model"
)

type Processor func(ctx context.Context, cfg Config, a acc, emit *Emitter) error

func Run(ctx context.Context, cfg config.Config, target Target, snapshotID string, emit *Emitter) error {
	var steps []Processor
	for _, region := range target.Regions {
		region := region
		for _, fn := range []Processor{collectInstances, collectVpcs, collectSecurityGroups} {
			fn := fn
			steps = append(steps, func(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
				a.region = region
				return fn(ctx, cfg, a, emit)
			})
		}
	}

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
			base := acc{accountID: target.AccountID, partition: target.Partition, snapshot: snapshotID}
			if err := step(ctx, cfg, base, emit); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return errors.Join(errs...)
}

func MakeSnapshot(snapshotID, accountID, partition string, regions []string, startedAt string, status string) model.Snapshot {
	return model.Snapshot{
		Kind:       "snapshot",
		SnapshotID: snapshotID,
		AccountID:  accountID,
		Partition:  partition,
		StartedAt:  startedAt,
		Status:     status,
		Regions:    regions,
		Statistics: map[string]int{},
	}
}
