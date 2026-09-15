package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"awsome/internal/collect"
	"awsome/internal/inspect"
)

type Manager struct {
	cfg    Cfg
	store  *Store
	bus    *Bus
	mu     sync.Mutex
	jobs   map[string]*Job
	order  []string
	active string
	cancel map[string]context.CancelFunc
	wake   chan struct{}
	done   chan struct{}
	wg     sync.WaitGroup
}

func NewManager(cfg Cfg, store *Store, bus *Bus) *Manager {
	return &Manager{
		cfg:    cfg,
		store:  store,
		bus:    bus,
		jobs:   map[string]*Job{},
		cancel: map[string]context.CancelFunc{},
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
}

func (m *Manager) Bus() *Bus { return m.bus }

func (m *Manager) Restore() {
	for _, j := range m.store.All() {
		switch j.Status {
		case StatusRunning, StatusCancelling, StatusQueued:
			if j.Status == StatusCancelling {
				j.Status = StatusCancelled
			} else {
				j.Status = StatusInterrupted
			}
		}
		m.jobs[j.ID] = j
		m.order = append(m.order, j.ID)
		_ = m.store.Save(j)
	}
}

func (m *Manager) Enqueue(cfg Cfg, target collect.Target, regions []string) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := New(newID(), cfg, target, regions)
	for _, id := range m.order {
		other := m.jobs[id]
		if other.Target == j.Target {
			switch other.Status {
			case StatusQueued, StatusRunning, StatusCancelling:
				return nil, fmt.Errorf("job for target already %s (%s)", other.Status, other.ID)
			}
		}
	}
	m.jobs[j.ID] = j
	m.order = append(m.order, j.ID)
	if err := m.store.Save(j); err != nil {
		return nil, err
	}
	select {
	case m.wake <- struct{}{}:
	default:
	}
	return m.clone(j), nil
}

func (m *Manager) List() []*Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Job, 0, len(m.order))
	for _, id := range m.order {
		out = append(out, m.clone(m.jobs[id]))
	}
	return out
}

func (m *Manager) Get(id string) (*Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return nil, false
	}
	return m.clone(j), true
}

func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("job not found")
	}
	var cancelFn context.CancelFunc
	switch j.Status {
	case StatusRunning:
		j.Status = StatusCancelling
		cancelFn = m.cancel[id]
		_ = m.store.Save(j)
		m.publishLocked(Event{Type: "job.cancelling", JobID: j.ID, Payload: m.clone(j)})
	case StatusQueued:
		j.Status = StatusCancelled
		j.FinishedAt = nowRFC()
		for i := range j.Steps {
			if j.Steps[i].Status != StatusCompleted {
				j.Steps[i].Status = StatusCancelled
			}
		}
		_ = m.store.Save(j)
		m.publishLocked(Event{Type: "job.final", JobID: j.ID, Payload: m.clone(j)})
	default:
		m.mu.Unlock()
		return fmt.Errorf("cannot cancel job in %s", j.Status)
	}
	m.mu.Unlock()
	if cancelFn != nil {
		cancelFn()
	}
	return nil
}

func (m *Manager) Resume(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return errors.New("job not found")
	}
	switch j.Status {
	case StatusInterrupted, StatusCancelled, StatusFailed:
	default:
		return fmt.Errorf("cannot resume job in %s", j.Status)
	}
	for i := range j.Steps {
		if j.Steps[i].Status != StatusCompleted {
			j.Steps[i].Status = StatusQueued
		}
	}
	j.Status = StatusQueued
	j.Error = ""
	j.FinishedAt = ""
	if err := m.store.Save(j); err != nil {
		return err
	}
	select {
	case m.wake <- struct{}{}:
	default:
	}
	return nil
}

func (m *Manager) Start() {
	m.wg.Add(1)
	go m.loop()
}

func (m *Manager) Stop() {
	m.mu.Lock()
	for _, c := range m.cancel {
		c()
	}
	m.mu.Unlock()
	close(m.done)
	m.wg.Wait()
	_ = m.store.Close()
}

func (m *Manager) loop() {
	defer m.wg.Done()
	for {
		m.mu.Lock()
		if m.active == "" {
			for _, id := range m.order {
				if m.jobs[id].Status == StatusQueued {
					m.active = id
					break
				}
			}
		}
		id := m.active
		m.mu.Unlock()

		if id == "" {
			select {
			case <-m.done:
				return
			case <-m.wake:
			}
			continue
		}
		m.run(id)
	}
}

func (m *Manager) run(id string) {
	now := time.Now().UTC()
	m.mu.Lock()
	j := m.jobs[id]
	j.Status = StatusRunning
	j.StartedAt = now.Format(time.RFC3339)
	j.Error = ""
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel[id] = cancel
	cfg := j.Config.ToConfig(j.Regions)
	m.publishLocked(Event{Type: "job.started", JobID: j.ID, Payload: m.clone(j)})
	_ = m.store.Save(j)
	m.mu.Unlock()

	emit := collect.NewEmitter(1024)
	dir := filepath.Join(j.Config.SnapshotDir, j.SnapshotID)
	var runErrs []error
	if err := os.MkdirAll(dir, 0o755); err != nil {
		runErrs = append(runErrs, err)
	}
	startedAt := modelNow()
	stats := map[string]int{}
	if len(runErrs) == 0 {
		recordsPath := filepath.Join(dir, "records.jsonl")
		statsCh := make(chan map[string]int, 1)
		werrCh := make(chan error, 1)
		go func() {
			s, werr := inspect.WriteRecords(recordsPath, emit.Chan())
			statsCh <- s
			werrCh <- werr
		}()
		runErrs = m.runSteps(ctx, j, cfg, emit)
		emit.Close()
		stats = <-statsCh
		if werr := <-werrCh; werr != nil {
			runErrs = append(runErrs, werr)
		}
	} else {
		emit.Close()
	}

	m.finalize(id, ctx, runErrs, stats, sortRegions(j.Regions), startedAt)
}

func (m *Manager) runSteps(ctx context.Context, j *Job, cfg collect.Config, emit *collect.Emitter) []error {
	var runErrs []error
	_ = cfg
	for i := range j.Steps {
		st := &j.Steps[i]

		m.mu.Lock()
		if j.Status == StatusCancelling || ctx.Err() != nil {
			finalizing := j.Status == StatusCancelling && ctx.Err() == nil
			if finalizing {
				for k := i; k < len(j.Steps); k++ {
					if j.Steps[k].Status != StatusCompleted {
						j.Steps[k].Status = StatusCancelled
					}
				}
			}
			m.mu.Unlock()
			break
		}
		st.Status = StatusRunning
		st.ScannedAt = modelNow()
		m.publishLocked(Event{Type: "step.started", JobID: j.ID, Payload: m.clone(j)})
		_ = m.store.Save(j)
		m.mu.Unlock()

		beforeNodes, beforeEdges := emit.Counts()
		err := collect.RunStep(ctx, cfg, st.Step, j.SnapshotID, emit)
		afterNodes, afterEdges := emit.Counts()

		m.mu.Lock()
		if err != nil {
			if collect.IsDegrade(err) {
				st.Skipped++
			} else {
				st.Failed++
				runErrs = append(runErrs, err)
			}
		}
		st.Status = StatusCompleted
		st.Nodes += afterNodes - beforeNodes
		st.Edges += afterEdges - beforeEdges
		m.publishLocked(Event{Type: "step.done", JobID: j.ID, Payload: m.clone(j)})
		_ = m.store.Save(j)
		m.mu.Unlock()
	}
	return runErrs
}

func (m *Manager) finalize(id string, ctx context.Context, runErrs []error, stats map[string]int, regions []string, startedAt string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.jobs[id]

	switch {
	case ctx.Err() != nil:
		if j.Status == StatusCancelling {
			j.Status = StatusCancelled
		} else {
			j.Status = StatusInterrupted
		}
	case len(runErrs) > 0:
		j.Status = StatusFailed
		j.Error = joinErrs(runErrs)
	default:
		j.Status = StatusCompleted
	}

	j.Nodes = int64(stats["nodes"])
	j.Edges = int64(stats["edges"])
	j.FinishedAt = nowRFC()
	delete(m.cancel, id)
	m.active = ""

	if err := os.MkdirAll(filepath.Join(j.Config.SnapshotDir, j.SnapshotID), 0o755); err == nil {
		snap := collect.MakeSnapshot(j.SnapshotID, j.AccountID, j.Partition, regions, startedAt, j.FinishedSnapshotStatus())
		snap.FinishedAt = modelNow()
		snap.Trigger = "job"
		snap.JobID = j.ID
		snap.Statistics = stats
		_ = inspect.WriteJSON(filepath.Join(j.Config.SnapshotDir, j.SnapshotID, "summary.json"), snap)
	}

	m.publishLocked(Event{Type: "job.final", JobID: j.ID, Payload: m.clone(j)})
	_ = m.store.Save(j)
}

func (m *Manager) publishLocked(e Event) { m.bus.Pub(e) }

func (m *Manager) clone(j *Job) *Job {
	b, _ := json.Marshal(j)
	var c Job
	_ = json.Unmarshal(b, &c)
	return &c
}

func newID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err == nil {
		return "job-" + hex.EncodeToString(b[:])
	}
	return fmt.Sprintf("job-%d", time.Now().UnixNano())
}

func nowRFC() string { return time.Now().UTC().Format(time.RFC3339) }

func modelNow() string { return time.Now().UTC().Format("20060102T150405Z") }

func sortRegions(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func joinErrs(errs []error) string {
	var out []string
	for _, e := range errs {
		out = append(out, e.Error())
	}
	return strings.Join(out, "; ")
}
