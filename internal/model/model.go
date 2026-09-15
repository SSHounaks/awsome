package model

import "time"

type Node struct {
	Kind       string            `json:"kind"`
	Label      string            `json:"label"`
	Key        string            `json:"key"`
	AccountID  string            `json:"account_id"`
	Partition  string            `json:"partition"`
	Region     string            `json:"region"`
	Name       string            `json:"name,omitempty"`
	Type       string            `json:"type,omitempty"`
	Tags       map[string]string `json:"tags,omitempty"`
	Properties map[string]any    `json:"properties,omitempty"`
	ScannedAt  string            `json:"scanned_at"`
	SnapshotID string            `json:"snapshot_id"`
}

type Edge struct {
	Kind       string `json:"kind"`
	From       string `json:"from"`
	To         string `json:"to"`
	Type       string `json:"type"`
	SnapshotID string `json:"snapshot_id"`
	ScannedAt  string `json:"scanned_at"`
}

// Coverage records the outcome of a single (service, region) walker so a
// snapshot is explicit about what it could *not* see. Without this a scan run
// under a restricted role looks identical to a scan of an empty account.
type Coverage struct {
	Kind       string `json:"kind"`
	Service    string `json:"service"`
	Region     string `json:"region"`
	Status     string `json:"status"`
	Reason     string `json:"reason,omitempty"`
	Error      string `json:"error,omitempty"`
	SnapshotID string `json:"snapshot_id"`
	ScannedAt  string `json:"scanned_at"`
}

type Snapshot struct {
	Kind       string         `json:"kind"`
	SnapshotID string         `json:"snapshot_id"`
	AccountID  string         `json:"account_id"`
	Partition  string         `json:"partition"`
	StartedAt  string         `json:"started_at"`
	FinishedAt string         `json:"finished_at"`
	Status     string         `json:"status"`
	Regions    []string       `json:"regions"`
	Statistics map[string]int `json:"statistics"`
	User       string         `json:"user,omitempty"`
	Hostname   string         `json:"hostname,omitempty"`
	Trigger    string         `json:"trigger,omitempty"`
	JobID      string         `json:"job_id,omitempty"`
}

func Now() string {
	return time.Now().UTC().Format(time.RFC3339)
}
