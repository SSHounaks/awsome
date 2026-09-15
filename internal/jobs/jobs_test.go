package jobs

import (
	"path/filepath"
	"testing"

	"awsome/internal/collect"
)

func tCfg(t *testing.T) Cfg {
	return Cfg{EndpointURL: "http://127.0.0.1:4566", SnapshotDir: t.TempDir(), Concurrency: 2}
}

func TestEnqueueDedupeAndQueueCancel(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "j.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	m := NewManager(tCfg(t), store, NewBus())
	target := collect.Target{AccountID: "000000000000", Partition: "aws", Regions: []string{"us-east-1"}}

	j1, err := m.Enqueue(tCfg(t), target, target.Regions)
	if err != nil || j1 == nil {
		t.Fatalf("enqueue 1: %v", err)
	}
	seen := 0
	for _, id := range m.order {
		if m.jobs[id].Target == j1.Target {
			seen++
		}
	}
	if seen != 1 {
		t.Fatalf("expected 1 job per target, saw %d", seen)
	}
	if _, err := m.Enqueue(tCfg(t), target, target.Regions); err == nil {
		t.Fatal("expected dedupe error on second enqueue, got nil")
	}
	if err := m.Cancel(j1.ID); err != nil {
		t.Fatalf("cancel queued: %v", err)
	}
	after, _ := m.Get(j1.ID)
	if after.Status != StatusCancelled {
		t.Fatalf("expected status cancelled, got %s", after.Status)
	}
	for _, s := range after.Steps {
		if s.Status != StatusCancelled {
			t.Fatalf("expected queued step cancelled on queued-job cancel, got %s", s.Status)
		}
	}
	if err := m.Resume(j1.ID); err != nil {
		t.Fatalf("resume cancelled: %v", err)
	}
	after, _ = m.Get(j1.ID)
	if after.Status != StatusQueued {
		t.Fatalf("expected status queued after resume, got %s", after.Status)
	}
	if err := m.Resume(j1.ID); err == nil {
		t.Fatal("resume of already-queued job should error")
	}
}

func TestRestoreInterrupted(t *testing.T) {
	dir := t.TempDir()
	store, _ := OpenStore(filepath.Join(dir, "j.db"))
	target := collect.Target{AccountID: "1", Partition: "aws", Regions: []string{"us-east-1"}}
	m := NewManager(tCfg(t), store, NewBus())
	queued, _ := m.Enqueue(tCfg(t), target, target.Regions)
	store.Save(&Job{ID: "job-running", SnapshotID: "snap-x", Status: StatusRunning, Target: queued.Target, Steps: queued.Steps, CreatedAt: queued.CreatedAt})
	store.Save(&Job{ID: "job-cancelling", SnapshotID: "snap-y", Status: StatusCancelling, Target: queued.Target + "|2", Steps: queued.Steps, CreatedAt: queued.CreatedAt})
	_ = store.Close()
	m.mu.Lock()
	for k := range m.jobs {
		delete(m.jobs, k)
	}
	m.order = nil
	m.mu.Unlock()

	store2, _ := OpenStore(filepath.Join(dir, "j.db"))
	defer store2.Close()
	m2 := NewManager(tCfg(t), store2, NewBus())
	m2.Restore()
	for id, want := range map[string]Status{"job-running": StatusInterrupted, "job-cancelling": StatusCancelled, queued.ID: StatusInterrupted} {
		got, ok := m2.Get(id)
		if !ok {
			t.Fatalf("job %s missing after restore", id)
		}
		if got.Status != want {
			t.Fatalf("job %s: want %s, got %s", id, want, got.Status)
		}
	}
}
