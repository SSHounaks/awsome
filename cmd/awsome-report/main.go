package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"awsome/internal/findings"
	"awsome/internal/inspect"
)

func main() {
	dir := flag.String("dir", "", "snapshot directory (default: latest under ./snapshots)")
	flag.Parse()

	if *dir == "" {
		latest, err := latestSnapshotDir("snapshots")
		if err != nil {
			fmt.Fprintln(os.Stderr, "dir:", err)
			os.Exit(1)
		}
		dir = &latest
	}

	records := filepath.Join(*dir, "records.jsonl")
	g, err := findings.LoadRecords(records)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load records:", err)
		os.Exit(1)
	}
	if len(g.Nodes) == 0 {
		fmt.Fprintln(os.Stderr, "no nodes in", records)
		os.Exit(1)
	}

	fns := findings.Run(g)
	outPath := filepath.Join(*dir, "findings.json")
	if err := inspect.WriteJSON(outPath, fns); err != nil {
		fmt.Fprintln(os.Stderr, "write findings:", err)
		os.Exit(1)
	}

	printSummary(fns, outPath)
}

func latestSnapshotDir(root string) (string, error) {
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

func printSummary(fns []findings.Finding, outPath string) {
	bySev := map[string]int{}
	byRule := map[string]int{}
	for _, f := range fns {
		bySev[f.Severity]++
		byRule[f.Rule]++
	}
	fmt.Printf("findings  %d total → %s\n", len(fns), outPath)
	for _, s := range []string{"critical", "high", "medium", "low", "info"} {
		if n := bySev[s]; n > 0 {
			fmt.Printf("  %-9s %d\n", s, n)
		}
	}
	if len(fns) == 0 {
		fmt.Println("  (clean — no findings fired)")
		return
	}
	fmt.Println("  by rule:")
	var rules []string
	for r := range byRule {
		rules = append(rules, r)
	}
	sort.Strings(rules)
	for _, r := range rules {
		fmt.Printf("    %-28s %d\n", r, byRule[r])
	}
	top := fns
	if len(top) > 10 {
		top = top[:10]
	}
	fmt.Println("  top findings:")
	for _, f := range top {
		name := f.ResourceName
		if name == "" {
			name = f.ResourceLabel
		}
		fmt.Printf("    [%s] %s %s — %s → %s\n", f.Severity, f.Rule, name, f.Message, f.Remediation)
	}
}
