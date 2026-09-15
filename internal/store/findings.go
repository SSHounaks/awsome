package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"awsome/internal/findings"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

func LoadFindings(ctx context.Context, cfg Neo4jConfig, path string) (LoadStats, error) {
	var st LoadStats
	raw, err := os.ReadFile(path)
	if err != nil {
		return st, fmt.Errorf("read findings: %w", err)
	}
	var fns []findings.Finding
	if err := json.Unmarshal(raw, &fns); err != nil {
		return st, fmt.Errorf("parse findings: %w", err)
	}
	if len(fns) == 0 {
		return st, nil
	}

	db, err := neo4j.NewDriverWithContext(cfg.URI, neo4j.BasicAuth(cfg.User, cfg.Password, ""))
	if err != nil {
		return st, fmt.Errorf("neo4j driver: %w", err)
	}
	defer db.Close(ctx)

	if err := db.VerifyConnectivity(ctx); err != nil {
		return st, fmt.Errorf("neo4j connectivity %s: %w", cfg.URI, err)
	}
	scfg := neo4j.SessionConfig{}
	if cfg.Database != "" {
		scfg.DatabaseName = cfg.Database
	}
	s := db.NewSession(ctx, scfg)
	defer s.Close(ctx)

	if err := execWrite(ctx, s, "CREATE CONSTRAINT awsome_finding_key IF NOT EXISTS FOR (f:Finding) REQUIRE f.key IS UNIQUE", nil); err != nil {
		return st, fmt.Errorf("schema: %w", err)
	}

	for i := 0; i < len(fns); i += batchSize {
		end := min(i+batchSize, len(fns))
		cypher := `UNWIND $batch AS f
			MERGE (x:Finding {key: f.key})
			SET x.severity = f.severity, x.rule = f.rule, x.category = f.category,
			    x.resource_label = f.resource_label, x.resource_key = f.resource_key,
			    x.resource_name = f.resource_name, x.account_id = f.account_id,
			    x.region = f.region, x.snapshot_id = f.snapshot_id,
			    x.message = f.message, x.remediation = f.remediation,
			    x.evidence = f.evidence`
		if err := execWrite(ctx, s, cypher, map[string]any{"batch": findingParams(fns[i:end])}); err != nil {
			st.Skipped += end - i
			st.LastErr = fmt.Errorf("findings: %w", err)
			continue
		}
		st.Nodes += end - i
		st.Batches++
	}

	for i := 0; i < len(fns); i += batchSize {
		end := min(i+batchSize, len(fns))
		cypher := `UNWIND $batch AS f
			MATCH (x:Finding {key: f.key})
			MATCH (r:Resource {key: f.resource_key})
			MERGE (x)-[:AFFECTS]->(r)
			SET r.snapshot_id = f.snapshot_id`
		if err := execWrite(ctx, s, cypher, map[string]any{"batch": findingParams(fns[i:end])}); err != nil {
			st.Relations += 0
			st.LastErr = fmt.Errorf("finding edges: %w", err)
			continue
		}
		st.Edges += end - i
		st.Relations++
	}
	return st, nil
}

func findingParams(fns []findings.Finding) []any {
	out := make([]any, 0, len(fns))
	for _, f := range fns {
		evidence := "{}"
		if len(f.Evidence) > 0 {
			if b, err := json.Marshal(f.Evidence); err == nil {
				evidence = string(b)
			}
		}
		name := f.ResourceName
		if name != "" {
			name = f.ResourceName
		}
		out = append(out, map[string]any{
			"key":            f.ID,
			"severity":       f.Severity,
			"rule":           f.Rule,
			"category":       f.Category,
			"resource_label": f.ResourceLabel,
			"resource_key":   f.ResourceKey,
			"resource_name":  name,
			"account_id":     f.AccountID,
			"region":         f.Region,
			"snapshot_id":    f.SnapshotID,
			"message":        f.Message,
			"remediation":    f.Remediation,
			"evidence":       evidence,
		})
	}
	return out
}
