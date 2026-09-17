package config

import (
	"flag"
	"os"
	"strings"
	"time"
)

type Config struct {
	EndpointURL   string
	Regions       string
	SnapshotDir   string
	SnapshotID    string
	Concurrency   int
	Profile       string
	Profiles      string
	ControlAddr   string
	TrailLookback time.Duration
	TrailMax      int
	TrailReadOnly bool
}

func Parse(args []string) (Config, error) {
	fs := flag.NewFlagSet("awsome-scanner", flag.ContinueOnError)
	var c Config
	fs.StringVar(&c.EndpointURL, "endpoint-url", os.Getenv("AWS_ENDPOINT_URL"), "base AWS endpoint (LocalStack, etc.); empty = real AWS")
	fs.StringVar(&c.Regions, "regions", "", "comma-separated region allow-list; empty = autodetect")
	fs.StringVar(&c.SnapshotDir, "out", "snapshots", "directory for snapshot bundles")
	fs.StringVar(&c.SnapshotID, "snapshot-id", "", "override snapshot id (default: snap-<UTC timestamp>)")
	fs.IntVar(&c.Concurrency, "concurrency", 4, "max parallel scan steps")
	fs.StringVar(&c.Profile, "profile", "", "AWS profile to use")
	fs.StringVar(&c.Profiles, "profiles", "", "comma-separated AWS profiles to scan in one pass, one per account")
	fs.StringVar(&c.ControlAddr, "control", "", "serve control plane on this address (empty = one-shot scan)")
	fs.DurationVar(&c.TrailLookback, "trail-lookback", 168*time.Hour, "CloudTrail lookback window for drift attribution (0 = skip the trail step)")
	fs.IntVar(&c.TrailMax, "trail-max-events", 20000, "stop paginating CloudTrail after this many events (0 = no cap)")
	fs.BoolVar(&c.TrailReadOnly, "trail-include-readonly", false, "also capture read-only CloudTrail events (drift attribution only needs mutations)")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if c.Regions != "" {
		if _, err := splitRegions(c.Regions); err != nil {
			return c, err
		}
	}
	return c, nil
}

func (c Config) RegionAllowList() ([]string, error) { return splitRegions(c.Regions) }

// ProfileList is the set of accounts to scan. --profiles wins over --profile;
// with neither, the empty string means "whatever the environment resolves to",
// which keeps single-account behaviour unchanged.
func (c Config) ProfileList() []string {
	if c.Profiles != "" {
		var out []string
		for _, p := range strings.Split(c.Profiles, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return []string{c.Profile}
}

func splitRegions(raw string) ([]string, error) {
	if raw == "" {
		return nil, nil
	}
	var out []string
	for _, r := range strings.Split(raw, ",") {
		r = strings.TrimSpace(r)
		if r != "" {
			out = append(out, r)
		}
	}
	return out, nil
}
