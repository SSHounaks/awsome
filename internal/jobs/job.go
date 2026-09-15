package jobs

import (
	"fmt"
	"strings"
	"time"

	"awsome/internal/collect"
	"awsome/internal/config"
)

type Status string

const (
	StatusQueued      Status = "queued"
	StatusRunning     Status = "running"
	StatusCancelling  Status = "cancelling"
	StatusCancelled   Status = "cancelled"
	StatusCompleted   Status = "completed"
	StatusFailed      Status = "failed"
	StatusInterrupted Status = "interrupted"
)

type Step struct {
	collect.Step
	Status    Status `json:"status"`
	Nodes     int64  `json:"nodes,omitempty"`
	Edges     int64  `json:"edges,omitempty"`
	Skipped   int64  `json:"skipped,omitempty"`
	Failed    int64  `json:"failed,omitempty"`
	ScannedAt string `json:"scanned_at,omitempty"`
}

type Job struct {
	ID         string   `json:"id"`
	SnapshotID string   `json:"snapshot_id"`
	Status     Status   `json:"status"`
	Target     string   `json:"target"`
	AccountID  string   `json:"account_id,omitempty"`
	Partition  string   `json:"partition,omitempty"`
	Regions    []string `json:"regions"`
	Config     Cfg      `json:"cfg"`
	Steps      []Step   `json:"steps"`
	Nodes      int64    `json:"nodes,omitempty"`
	Edges      int64    `json:"edges,omitempty"`
	Error      string   `json:"error,omitempty"`
	CreatedAt  string   `json:"created_at"`
	StartedAt  string   `json:"started_at,omitempty"`
	FinishedAt string   `json:"finished_at,omitempty"`
}

type Cfg struct {
	EndpointURL string `json:"endpoint_url,omitempty"`
	Profile     string `json:"profile,omitempty"`
	SnapshotDir string `json:"snapshot_dir"`
	Concurrency int    `json:"concurrency,omitempty"`
}

func CfgFrom(c config.Config) Cfg {
	return Cfg{EndpointURL: c.EndpointURL, Profile: c.Profile, SnapshotDir: c.SnapshotDir, Concurrency: c.Concurrency}
}

func (c Cfg) ToConfig(regions []string) collect.Config {
	return collect.Config{
		EndpointURL: c.EndpointURL,
		Profile:     c.Profile,
		SnapshotDir: c.SnapshotDir,
		Concurrency: c.Concurrency,
		Regions:     strings.Join(regions, ","),
	}
}

func targetKey(c Cfg, regions []string) string {
	return fmt.Sprintf("%s|%s|%s", c.EndpointURL, c.Profile, strings.Join(regions, ","))
}

func New(ID string, c Cfg, target collect.Target, regions []string) *Job {
	now := time.Now().UTC()
	return &Job{
		ID:         ID,
		SnapshotID: "snap-" + now.Format("20060102T150405Z"),
		Status:     StatusQueued,
		Target:     targetKey(c, regions),
		AccountID:  target.AccountID,
		Partition:  target.Partition,
		Regions:    regions,
		Config:     c,
		Steps:      toSteps(collect.Plan(target)),
		CreatedAt:  now.Format(time.RFC3339),
	}
}

func (j *Job) FinishedSnapshotStatus() string {
	switch j.Status {
	case StatusCompleted:
		return "complete"
	case StatusCancelled:
		return "cancelled"
	case StatusFailed:
		return "partial"
	default:
		return "interrupted"
	}
}

func toSteps(in []collect.Step) []Step {
	out := make([]Step, 0, len(in))
	for _, s := range in {
		out = append(out, Step{Step: s, Status: StatusQueued})
	}
	return out
}
