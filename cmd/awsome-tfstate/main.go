// Command awsome-tfstate reads Terraform state and records which resources
// infrastructure-as-code declares, so a scan can tell managed resources from
// ones that exist only in the console.
//
// It is a separate command from the scanner on purpose. Reading state needs
// s3:GetObject on the state bucket — a data-plane read of a secret-bearing
// object, and a higher privilege than posture scanning. Keeping it separate
// means the scan itself can keep running under a read-only or SecurityAudit
// role, and the state read is an explicit, separately-credentialed step.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"awsome/internal/awscfg"
	"awsome/internal/tfstate"
)

type stateRef struct {
	AccountID string `json:"account_id"`
	Bucket    string `json:"bucket"`
	Key       string `json:"key"`
	Region    string `json:"region"`
	Profile   string `json:"profile"`
	// Path reads a local state file instead of S3, for testing or air-gapped use.
	Path string `json:"path,omitempty"`
}

type conf struct {
	States []stateRef `json:"states"`
}

func main() {
	cfgPath := flag.String("config", ".awsome-tfstate.json", "state locations, one entry per account")
	dir := flag.String("dir", "", "snapshot directory (default: latest under ./snapshots)")
	flag.Parse()

	raw, err := os.ReadFile(*cfgPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n(see .awsome-tfstate.example.json)\n", err)
		os.Exit(1)
	}
	var c conf
	if err := json.Unmarshal(raw, &c); err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(1)
	}
	if len(c.States) == 0 {
		fmt.Fprintln(os.Stderr, "config: no states configured")
		os.Exit(1)
	}

	snapDir := *dir
	if snapDir == "" {
		snapDir, err = latestSnapshot("snapshots")
		if err != nil {
			fmt.Fprintln(os.Stderr, "dir:", err)
			os.Exit(1)
		}
	}
	snapshotID := filepath.Base(snapDir)
	scannedAt := time.Now().UTC().Format(time.RFC3339)

	out, err := os.Create(filepath.Join(snapDir, "declared.jsonl"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "create declared.jsonl:", err)
		os.Exit(1)
	}
	defer out.Close()
	enc := json.NewEncoder(out)

	ctx := context.Background()
	var failures int
	for _, ref := range c.States {
		rc, err := open(ctx, ref)
		if err != nil {
			// One unreadable state must not cost the others: state buckets live
			// in different accounts with different permissions.
			fmt.Fprintf(os.Stderr, "skip %s: %v\n", ref.AccountID, err)
			failures++
			continue
		}
		decls, meta, err := tfstate.Parse(rc, ref.AccountID, snapshotID, scannedAt)
		rc.Close()
		if err != nil {
			fmt.Fprintf(os.Stderr, "skip %s: %v\n", ref.AccountID, err)
			failures++
			continue
		}
		for i := range decls {
			if err := enc.Encode(&decls[i]); err != nil {
				fmt.Fprintln(os.Stderr, "write:", err)
				os.Exit(1)
			}
		}
		fmt.Printf("%s  terraform %s serial %d  %d managed  %d declared\n",
			ref.AccountID, meta.TerraformVersion, meta.Serial, meta.Managed, meta.Declared)
	}

	fmt.Printf("declared  → %s\n", filepath.Join(snapDir, "declared.jsonl"))
	if failures == len(c.States) {
		fmt.Fprintln(os.Stderr, "no state could be read")
		os.Exit(1)
	}
}

func open(ctx context.Context, ref stateRef) (io.ReadCloser, error) {
	if ref.Path != "" {
		return os.Open(ref.Path)
	}
	if ref.Bucket == "" || ref.Key == "" {
		return nil, fmt.Errorf("needs bucket+key or path")
	}
	sdk, err := awscfg.Load(ctx, "", ref.Region, ref.Profile)
	if err != nil {
		return nil, err
	}
	obj, err := s3.NewFromConfig(sdk).GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(ref.Bucket),
		Key:    aws.String(ref.Key),
	})
	if err != nil {
		return nil, err
	}
	return obj.Body, nil
}

func latestSnapshot(root string) (string, error) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	var dirs []string
	for _, e := range ents {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	if len(dirs) == 0 {
		return "", fmt.Errorf("no snapshots under %s", root)
	}
	sort.Strings(dirs)
	return filepath.Join(root, dirs[len(dirs)-1]), nil
}
