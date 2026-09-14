package inspect

import (
	"bufio"
	"encoding/json"
	"os"

	"awsome/internal/model"
)

func WriteRecords(path string, ch <-chan any) (map[string]int, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	defer w.Flush()

	enc := json.NewEncoder(w)
	stats := map[string]int{}
	for r := range ch {
		if err := enc.Encode(r); err != nil {
			return stats, err
		}
		switch v := r.(type) {
		case model.Node:
			stats["nodes"]++
			stats["nodes:"+v.Label]++
		case model.Edge:
			stats["edges"]++
			stats["edges:"+v.Type]++
		}
	}
	return stats, nil
}

func WriteJSON(path string, v any) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(v)
}
