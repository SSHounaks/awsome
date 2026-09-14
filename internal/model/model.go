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
}

func Now() string {
	return time.Now().UTC().Format(time.RFC3339)
}
