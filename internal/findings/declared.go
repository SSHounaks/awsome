package findings

import (
	"bufio"
	"encoding/json"
	"os"
	"regexp"
	"strings"

	"awsome/internal/model"
)

// Declaration is one resource Terraform manages, as written by awsome-tfstate.
type Declaration struct {
	Address    string `json:"address"`
	Type       string `json:"type"`
	Name       string `json:"name"`
	ARN        string `json:"arn,omitempty"`
	ResourceID string `json:"resource_id,omitempty"`
	AccountID  string `json:"account_id"`
}

// DeclarationIndex answers "is this live resource declared in Terraform?".
type DeclarationIndex struct {
	byARN    map[string]Declaration
	byID     map[string]Declaration
	accounts map[string]bool
	count    int
}

func LoadDeclarations(path string) (*DeclarationIndex, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			// No state ingested is not an error; the rule simply stays quiet.
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	idx := &DeclarationIndex{byARN: map[string]Declaration{}, byID: map[string]Declaration{}}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var d Declaration
		if json.Unmarshal(line, &d) != nil {
			continue
		}
		idx.count++
		if d.ARN != "" {
			idx.byARN[d.ARN] = d
		}
		if d.ResourceID != "" {
			idx.byID[d.ResourceID] = d
		}
	}
	return idx, sc.Err()
}

func (i *DeclarationIndex) Empty() bool { return i == nil || i.count == 0 }

// nodeSuffix is the resource id inside an ARN. An ARN is
// arn:partition:service:region:account:resource, where resource is "id",
// "type/id" or "type:id" — so the id is everything after the FIRST separator in
// the resource part, not the last. Splitting on the last "/" silently truncated
// ids that legitimately contain one: the ECR repository "icf/api" became "api"
// and never matched its declaration.
func nodeSuffix(key string) string {
	if !strings.HasPrefix(key, "arn:") {
		return key
	}
	parts := strings.SplitN(key, ":", 6)
	if len(parts) < 6 {
		return key
	}
	resource := parts[5]
	if i := strings.Index(resource, "/"); i >= 0 {
		return resource[i+1:]
	}
	if i := strings.Index(resource, ":"); i >= 0 {
		return resource[i+1:]
	}
	return resource
}

// derivedNodeSuffix strips AWS's generated suffix so a live resource can be
// matched to the Terraform resource that produced it. One Terraform block often
// materialises as several AWS resources with derived names — an ElastiCache
// replication group named "redis-api" becomes cluster nodes "redis-api-001",
// "redis-api-002". Without this, every such node looks unmanaged.
var nodeIndexSuffix = regexp.MustCompile(`-\d{3}$`)

func derivedNodeSuffix(label, suffix string) string {
	if label == "ELASTICACHE" {
		return nodeIndexSuffix.ReplaceAllString(suffix, "")
	}
	return ""
}

// Lookup reports whether a live resource is declared, and by which address.
func (i *DeclarationIndex) Lookup(label, key, name string) (Declaration, bool) {
	if i.Empty() {
		return Declaration{}, false
	}
	if d, ok := i.byARN[key]; ok {
		return d, true
	}
	suffix := nodeSuffix(key)
	for _, candidate := range []string{suffix, name, derivedNodeSuffix(label, suffix)} {
		if candidate == "" {
			continue
		}
		if d, ok := i.byID[candidate]; ok {
			return d, true
		}
		if d, ok := i.byARN[candidate]; ok {
			return d, true
		}
	}
	return Declaration{}, false
}

// managedCheckLabels are the labels where "declared in Terraform" is a reliable
// question. Everything else is excluded on purpose: ENIs and AMIs are created
// implicitly by other resources, IAM instance profiles are often generated, and
// flagging those would report a modelling gap as a governance failure.
var managedCheckLabels = map[string]bool{
	"EC2": true, "S3BUCKET": true, "RDS": true, "LAMBDA": true,
	"DYNAMODBTABLE": true, "ECRREPOSITORY": true, "LB": true,
	"ELASTICACHE": true, "ECSCLUSTER": true, "EKS": true, "ASG": true,
	"REDSHIFT": true, "OPENSEARCH": true,
}

// awsManagedRole matches roles AWS creates and owns; Terraform never declares
// them, so their absence from state is correct rather than drift.
func awsManagedResource(n model.Node) bool {
	path, _ := n.Properties["path"].(string)
	return strings.HasPrefix(path, "/aws-service-role/") ||
		strings.HasPrefix(path, "/service-role/")
}

// ruleUnmanagedResource flags live resources that no Terraform state declares.
// These are the ones created by hand, which no plan will ever correct and no
// review ever saw.
func ruleUnmanagedResource(g *Graph) []Finding {
	if g.Declarations.Empty() {
		return nil
	}
	var out []Finding
	for _, n := range g.Nodes {
		if !managedCheckLabels[n.Label] {
			continue
		}
		// Only accounts whose state was actually ingested can be judged.
		if !g.Declarations.coversAccount(n.AccountID) {
			continue
		}
		if awsManagedResource(n) {
			continue
		}
		if _, ok := g.Declarations.Lookup(n.Label, n.Key, n.Name); ok {
			continue
		}
		out = append(out, nfEv(n, "unmanaged-resource", "medium", "governance",
			resourceDesc(n)+" exists in the account but no Terraform state declares it",
			"Import it into Terraform, or delete it if it was a one-off",
			map[string]any{"account_id": n.AccountID}))
	}
	return out
}

// coversAccount reports whether state was ingested for this account. Judging an
// account whose state was never read would flag everything it owns.
func (i *DeclarationIndex) coversAccount(accountID string) bool {
	if i.Empty() || accountID == "" {
		return false
	}
	if i.accounts == nil {
		i.accounts = map[string]bool{}
		for _, d := range i.byARN {
			i.accounts[d.AccountID] = true
		}
		for _, d := range i.byID {
			i.accounts[d.AccountID] = true
		}
	}
	return i.accounts[accountID]
}
