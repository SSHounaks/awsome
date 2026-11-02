// Package tfstate reads Terraform state and reduces it to declarations — which
// resources infrastructure-as-code claims to manage.
//
// It deliberately keeps ONLY identity fields (address, type, name, arn, id).
// Terraform state stores every attribute in plaintext, including SSM
// SecureString values, database passwords and connection strings; a posture tool
// that copied those into its own snapshots would become the leak it exists to
// find. Answering "is this live resource declared anywhere?" needs identity and
// nothing else, so nothing else is read.
//
// Comparing *attribute values* between declared and live state is a separate
// problem that needs an explicit allowlist of non-secret, security-relevant
// fields. It is not done here.
package tfstate

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Declared is one resource Terraform manages.
type Declared struct {
	Kind       string `json:"kind"`
	Address    string `json:"address"`
	Type       string `json:"type"`
	Name       string `json:"name"`
	Module     string `json:"module,omitempty"`
	ARN        string `json:"arn,omitempty"`
	ResourceID string `json:"resource_id,omitempty"`
	AccountID  string `json:"account_id"`
	SnapshotID string `json:"snapshot_id"`
	ScannedAt  string `json:"scanned_at"`
}

// state mirrors only the parts of the Terraform state format v4 we read.
type state struct {
	Version   int    `json:"version"`
	Terraform string `json:"terraform_version"`
	Serial    int    `json:"serial"`
	Resources []struct {
		Module    string `json:"module"`
		Mode      string `json:"mode"`
		Type      string `json:"type"`
		Name      string `json:"name"`
		Instances []struct {
			IndexKey   any             `json:"index_key"`
			Attributes json.RawMessage `json:"attributes"`
		} `json:"instances"`
	} `json:"resources"`
}

// identity is the only slice of an instance's attributes that is read.
type identity struct {
	ARN  string `json:"arn"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Meta struct {
	Version          int
	TerraformVersion string
	Serial           int
	Managed          int
	Declared         int
}

// Parse reduces a Terraform state document to its declarations.
func Parse(r io.Reader, accountID, snapshotID, scannedAt string) ([]Declared, Meta, error) {
	var st state
	if err := json.NewDecoder(r).Decode(&st); err != nil {
		return nil, Meta{}, fmt.Errorf("decode terraform state: %w", err)
	}
	if st.Version != 4 {
		// Refuse rather than silently mis-read: the attribute layout differs
		// across state versions and a wrong read looks like mass drift.
		return nil, Meta{}, fmt.Errorf("unsupported terraform state version %d (expected 4)", st.Version)
	}

	meta := Meta{Version: st.Version, TerraformVersion: st.Terraform, Serial: st.Serial}
	var out []Declared

	for _, res := range st.Resources {
		// "data" blocks read existing infrastructure; they declare nothing.
		if res.Mode != "managed" {
			continue
		}
		meta.Managed++
		for _, inst := range res.Instances {
			var id identity
			if len(inst.Attributes) > 0 {
				// Errors are ignored on purpose: a resource whose attributes do
				// not carry arn/id still counts as declared, just unmatchable.
				_ = json.Unmarshal(inst.Attributes, &id)
			}
			out = append(out, Declared{
				Kind:       "declared",
				Address:    address(res.Module, res.Type, res.Name, inst.IndexKey),
				Type:       res.Type,
				Name:       res.Name,
				Module:     res.Module,
				ARN:        id.ARN,
				ResourceID: id.ID,
				AccountID:  accountID,
				SnapshotID: snapshotID,
				ScannedAt:  scannedAt,
			})
		}
	}
	meta.Declared = len(out)
	return out, meta, nil
}

// address rebuilds the Terraform address, so a finding can name the exact block
// to edit rather than just the resource type.
func address(module, typ, name string, indexKey any) string {
	var b strings.Builder
	if module != "" {
		b.WriteString(module)
		b.WriteString(".")
	}
	b.WriteString(typ)
	b.WriteString(".")
	b.WriteString(name)
	switch k := indexKey.(type) {
	case string:
		fmt.Fprintf(&b, "[%q]", k)
	case float64:
		fmt.Fprintf(&b, "[%d]", int(k))
	}
	return b.String()
}
