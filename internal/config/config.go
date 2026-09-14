package config

import (
	"flag"
	"os"
	"strings"
)

type Config struct {
	EndpointURL string
	Regions     string
	SnapshotDir string
	SnapshotID  string
	Concurrency int
	Profile     string
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
