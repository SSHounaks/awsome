package findings

import (
	"bufio"
	"encoding/json"
	"os"

	"awsome/internal/model"
)

type Graph struct {
	Nodes []model.Node
	Edges []model.Edge
	byKey map[string]model.Node
}

func LoadRecords(path string) (*Graph, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	g := &Graph{byKey: map[string]model.Node{}}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var kind struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(line, &kind); err != nil {
			return nil, err
		}
		switch kind.Kind {
		case "node":
			var n model.Node
			if err := json.Unmarshal(line, &n); err != nil {
				return nil, err
			}
			g.Nodes = append(g.Nodes, n)
			if _, ok := g.byKey[n.Key]; !ok {
				g.byKey[n.Key] = n
			}
		case "edge":
			var e model.Edge
			if err := json.Unmarshal(line, &e); err != nil {
				return nil, err
			}
			g.Edges = append(g.Edges, e)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return g, nil
}

func (g *Graph) Node(key string) (model.Node, bool) {
	n, ok := g.byKey[key]
	return n, ok
}

func (g *Graph) NodesWithLabel(label string) []model.Node {
	var out []model.Node
	for _, n := range g.Nodes {
		if n.Label == label {
			out = append(out, n)
		}
	}
	return out
}

func (g *Graph) EdgesTo(key string) []model.Edge {
	var out []model.Edge
	for _, e := range g.Edges {
		if e.To == key {
			out = append(out, e)
		}
	}
	return out
}

func (g *Graph) EdgesFrom(key string) []model.Edge {
	var out []model.Edge
	for _, e := range g.Edges {
		if e.From == key {
			out = append(out, e)
		}
	}
	return out
}
