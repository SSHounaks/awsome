package collect

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	ct "github.com/aws/aws-sdk-go-v2/service/cloudtrail"
	cttypes "github.com/aws/aws-sdk-go-v2/service/cloudtrail/types"

	"awsome/internal/awscfg"
)

type trailRecord struct {
	EventID     string     `json:"event_id,omitempty"`
	EventTime   string     `json:"event_time,omitempty"`
	EventName   string     `json:"event_name,omitempty"`
	ReadOnly    bool       `json:"read_only,omitempty"`
	Region      string     `json:"region,omitempty"`
	Username    string     `json:"username,omitempty"`
	UserARN     string     `json:"user_arn,omitempty"`
	AccessKeyID string     `json:"access_key_id,omitempty"`
	UserType    string     `json:"user_type,omitempty"`
	SourceIP    string     `json:"source_ip,omitempty"`
	Resources   []trailRes `json:"resources,omitempty"`
}

type trailRes struct {
	Type string `json:"type,omitempty"`
	Name string `json:"name,omitempty"`
}

type rawTrailEvent struct {
	UserIdentity *struct {
		Type        string `json:"type"`
		ARN         string `json:"arn"`
		AccessKeyID string `json:"accessKeyId"`
		UserName    string `json:"userName"`
	} `json:"userIdentity"`
	SourceIPAddress string `json:"sourceIPAddress"`
}

func collectTrail(ctx context.Context, cfg Config, a acc) error {
	if cfg.TrailLookback == 0 {
		return nil
	}
	c, err := awscfg.Load(ctx, cfg.EndpointURL, a.region, cfg.Profile)
	if err != nil {
		return err
	}
	cli := ct.NewFromConfig(c)

	f, err := os.Create(filepath.Join(cfg.SnapshotDir, a.snapshot, "trail.jsonl"))
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)

	// LookupEvents is throttled to a few TPS and pages 50 at a time, so an
	// unbounded walk of the full 90-day retention can take hours on a busy
	// account. Drift attribution only needs mutations inside the window between
	// two snapshots, so bound the window and filter read-only events server-side.
	in := &ct.LookupEventsInput{MaxResults: aws.Int32(50)}
	if cfg.TrailLookback > 0 {
		start := time.Now().UTC().Add(-cfg.TrailLookback)
		in.StartTime = aws.Time(start)
	}
	if !cfg.TrailReadOnly {
		in.LookupAttributes = []cttypes.LookupAttribute{{
			AttributeKey:   cttypes.LookupAttributeKeyReadOnly,
			AttributeValue: aws.String("false"),
		}}
	}

	count := 0
	for {
		out, err := cli.LookupEvents(ctx, in)
		if err != nil {
			return fmt.Errorf("cloudtrail lookup: %w", err)
		}
		for _, e := range out.Events {
			r := trailRecord{
				EventID:   aws.ToString(e.EventId),
				EventName: aws.ToString(e.EventName),
				ReadOnly:  aws.ToString(e.ReadOnly) == "true",
				Username:  aws.ToString(e.Username),
				Region:    a.region,
			}
			if e.EventTime != nil {
				r.EventTime = e.EventTime.UTC().Format(time.RFC3339)
			}
			for _, res := range e.Resources {
				r.Resources = append(r.Resources, trailRes{
					Type: aws.ToString(res.ResourceType),
					Name: aws.ToString(res.ResourceName),
				})
			}
			if e.CloudTrailEvent != nil {
				var raw rawTrailEvent
				if json.Unmarshal([]byte(*e.CloudTrailEvent), &raw) == nil {
					r.SourceIP = raw.SourceIPAddress
					if raw.UserIdentity != nil {
						r.UserARN = raw.UserIdentity.ARN
						r.AccessKeyID = raw.UserIdentity.AccessKeyID
						r.UserType = raw.UserIdentity.Type
						if r.Username == "" {
							r.Username = raw.UserIdentity.UserName
						}
					}
				}
			}
			if err := enc.Encode(&r); err != nil {
				return err
			}
			count++
		}
		if out.NextToken == nil {
			break
		}
		if cfg.TrailMax > 0 && count >= cfg.TrailMax {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		in.NextToken = out.NextToken
	}
	return nil
}
