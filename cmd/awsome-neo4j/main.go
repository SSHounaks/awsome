package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"awsome/internal/store"
)

func main() {
	var (
		dir      = flag.String("dir", "", "snapshot directory with records.jsonl")
		uri      = flag.String("uri", "bolt://127.0.0.1:7687", "neo4j uri")
		user     = flag.String("user", "neo4j", "neo4j user")
		password = flag.String("password", "awsome-dev-pass", "neo4j password")
		database = flag.String("database", "", "neo4j database name (default system db)")
		findings = flag.String("findings", "", "findings.json path (default <dir>/findings.json if present; empty disables)")
	)
	flag.Parse()
	set := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "findings" {
			set = true
		}
	})
	if !set {
		*findings = "auto"
	}

	if *dir == "" {
		*dir, _ = latest("snapshots")
	}
	records := filepath.Join(*dir, "records.jsonl")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	start := time.Now()
	st, err := store.LoadRecords(ctx, store.Neo4jConfig{
		URI: *uri, User: *user, Password: *password, Database: *database,
	}, records)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load:", err)
		os.Exit(1)
	}

	fmt.Printf("neo4j     %s\n", records)
	fmt.Printf("nodes     %d edges %d skipped %d batches %d relations %d\n",
		st.Nodes, st.Edges, st.Skipped, st.Batches, st.Relations)
	if st.LastErr != nil {
		fmt.Fprintln(os.Stderr, "last error:", st.LastErr)
	}

	if *findings != "" && *findings != "off" {
		fp := *findings
		if fp == "auto" {
			fp = filepath.Join(*dir, "findings.json")
		}
		if info, err := os.Stat(fp); err == nil && !info.IsDir() {
			fst, err := store.LoadFindings(ctx, store.Neo4jConfig{
				URI: *uri, User: *user, Password: *password, Database: *database,
			}, fp)
			if err != nil {
				fmt.Fprintln(os.Stderr, "findings:", err)
				os.Exit(1)
			}
			fmt.Printf("findings  %d nodes (%d :Finding) %d AFFECTS edges\n",
				fst.Nodes+fst.Edges, fst.Nodes, fst.Edges)
		} else {
			fmt.Println("findings  skip (no findings.json — run `make report` first)")
		}
	}

	fmt.Printf("duration  %s\n", time.Since(start).Round(time.Millisecond))
}

func latest(root string) (string, error) {
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
		return "", fmt.Errorf("no snapshots in %s", root)
	}
	sort.Strings(dirs)
	return filepath.Join(root, dirs[len(dirs)-1]), nil
}
