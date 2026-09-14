package collect

import (
	"context"
	"errors"
	"strings"
	"sync"

	"awsome/internal/config"
	"awsome/internal/model"
)

type Processor func(ctx context.Context, cfg Config, a acc, emit *Emitter) error

func Run(ctx context.Context, cfg config.Config, target Target, snapshotID string, emit *Emitter) error {
	var steps []Processor
	for _, region := range target.Regions {
		region := region
		for _, fn := range []Processor{
			collectInstances, collectVpcs, collectSecurityGroups,
			collectSubnets, collectVolumes, collectNetworkInterfaces, collectImages,
			collectRouteTables, collectNetworkACLs, collectInternetGateways,
			collectElasticIPs, collectVpcPeering, collectAutoScalingGroups,
			collectLoadBalancers, collectRdsInstances, collectRdsSubnetGroups,
			collectCacheClusters, collectRedshiftClusters, collectOpenSearchDomains,
			collectTables, collectFunctions, collectEcsClusters, collectEksClusters,
			collectBuckets, collectEcrRepositories,
		} {
			fn := fn
			steps = append(steps, func(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
				a.region = region
				return fn(ctx, cfg, a, emit)
			})
		}
	}
	if len(target.Regions) > 0 {
		globalRegion := target.Regions[0]
		steps = append(steps, func(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
			a.region = globalRegion
			return collectIam(ctx, cfg, a, emit)
		})
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
				if !degradeable(err) {
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

func degradeable(err error) bool {
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
