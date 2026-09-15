package store

import (
	"context"
	"fmt"

	"awsome/internal/findings"
	"awsome/internal/model"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

const batchSize = 500

type Neo4jConfig struct {
	URI      string
	User     string
	Password string
	Database string
}

type LoadStats struct {
	Nodes     int
	Edges     int
	Skipped   int
	Batches   int
	Relations int
	Fetches   int
	Creates   int
	LastErr   error
}

func LoadRecords(ctx context.Context, cfg Neo4jConfig, path string) (LoadStats, error) {
	var st LoadStats

	g, err := findings.LoadRecords(path)
	if err != nil {
		return st, fmt.Errorf("load records: %w", err)
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

	if err := execWrite(ctx, s, "CREATE CONSTRAINT awsome_resource_key IF NOT EXISTS FOR (n:Resource) REQUIRE n.key IS UNIQUE", nil); err != nil {
		return st, fmt.Errorf("schema: %w", err)
	}

	st.Batches = loadNodes(ctx, s, g.Nodes, &st)
	st.Relations = loadEdges(ctx, s, g.Nodes, g.Edges, &st)
	return st, nil
}

func loadNodes(ctx context.Context, s neo4j.SessionWithContext, nodes []model.Node, st *LoadStats) int {
	byLabel := map[string][]model.Node{}
	for _, n := range nodes {
		byLabel[Neo4jName(n.Label)] = append(byLabel[Neo4jName(n.Label)], n)
	}

	batches := 0
	for label, list := range byLabel {
		for i := 0; i < len(list); i += batchSize {
			end := min(i+batchSize, len(list))
			cypher := fmt.Sprintf(
				"UNWIND $batch AS n MERGE (r:Resource:`%s` {key: n.key}) SET r += n.data"+
					" SET r.account_id = n.aid, r.partition = n.partition, r.region = n.region,"+
					" r.name = COALESCE(n.name, r.name), r.type = COALESCE(n.type, r.type),"+
					" r.tags = COALESCE(n.tags, '{}'), r.snapshot_id = n.sid, r.scanned_at = n.scanned_at", label)
			if err := execWrite(ctx, s, cypher, map[string]any{"batch": nodeParams(list[i:end])}); err != nil {
				st.Skipped += end - i
				st.LastErr = fmt.Errorf("nodes[%s]: %w", label, err)
				continue
			}
			st.Nodes += end - i
			batches++
		}
	}
	return batches
}

func loadEdges(ctx context.Context, s neo4j.SessionWithContext, nodes []model.Node, edges []model.Edge, st *LoadStats) int {
	known := map[string]bool{}
	for _, n := range nodes {
		known[n.Key] = true
	}

	byType := map[string][]model.Edge{}
	for _, e := range edges {
		if !known[e.From] || !known[e.To] {
			st.Skipped++
			continue
		}
		byType[Neo4jName(e.Type)] = append(byType[Neo4jName(e.Type)], e)
	}

	relations := 0
	for t, list := range byType {
		for i := 0; i < len(list); i += batchSize {
			end := min(i+batchSize, len(list))
			cypher := fmt.Sprintf(
				"UNWIND $batch AS e MATCH (a:Resource {key: e.from}) MATCH (b:Resource {key: e.to})"+
					" MERGE (a)-[r:`%s`]->(b) SET r.snapshot_id = e.sid, r.scanned_at = e.scanned_at", t)
			if err := execWrite(ctx, s, cypher, map[string]any{"batch": edgeParams(list[i:end])}); err != nil {
				st.Skipped += end - i
				continue
			}
			st.Edges += end - i
			relations++
		}
	}
	return relations
}

func nodeParams(nodes []model.Node) []any {
	out := make([]any, 0, len(nodes))
	for _, n := range nodes {
		data := map[string]any{
			"aid":       n.AccountID,
			"partition": n.Partition,
			"region":    n.Region,
		}
		if n.Name != "" {
			data["name"] = n.Name
		}
		if n.Type != "" {
			data["type"] = n.Type
		}
		for k, v := range sanitizeProps(n.Properties) {
			data[k] = v
		}
		out = append(out, map[string]any{
			"key":        n.Key,
			"data":       data,
			"aid":        n.AccountID,
			"partition":  n.Partition,
			"region":     n.Region,
			"name":       n.Name,
			"type":       n.Type,
			"tags":       sanitizeTags(n.Tags),
			"sid":        n.SnapshotID,
			"scanned_at": n.ScannedAt,
		})
	}
	return out
}

func edgeParams(edges []model.Edge) []any {
	out := make([]any, 0, len(edges))
	for _, e := range edges {
		out = append(out, map[string]any{
			"from":       e.From,
			"to":         e.To,
			"sid":        e.SnapshotID,
			"scanned_at": e.ScannedAt,
		})
	}
	return out
}

func execWrite(ctx context.Context, s neo4j.SessionWithContext, cypher string, params map[string]any) error {
	_, err := s.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		_, err := tx.Run(ctx, cypher, params)
		return nil, err
	})
	return err
}
