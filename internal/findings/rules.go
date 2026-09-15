package findings

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"awsome/internal/model"
)

func ruleS3PublicBucket(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("S3BUCKET") {
		how := ""
		if acl, ok := n.Properties["acl_grantees"].([]any); ok {
			for _, a := range acl {
				m, _ := a.(map[string]any)
				uri, _ := m["grantee_uri"].(string)
				perm, _ := m["permission"].(string)
				if strings.Contains(uri, "AllUsers") || strings.Contains(uri, "AuthenticatedUsers") {
					how = "ACL grant " + perm + " → " + uri
					break
				}
			}
		}
		sev := "critical"
		if how == "" {
			if policy, ok := n.Properties["bucket_policy"].(string); ok && policy != "" {
				anon, conditioned := anonymousPolicyGrant(policy)
				if anon {
					how = "bucket policy grants anonymous principals"
					// What the anonymous grant actually permits matters more than
					// that it exists. Read-only access to object keys you already
					// know is how every static website works; the ability to list
					// the bucket (enumerate everything) or write to it is not.
					switch scope := anonymousGrantScope(policy); {
					case scope.write:
						how += " with WRITE access"
					case scope.list:
						how += " that can list bucket contents"
						sev = "high"
					default:
						how += " read-only (s3:GetObject, no s3:ListBucket, so object keys cannot be enumerated)"
						sev = "medium"
					}
					if conditioned {
						// e.g. Principal:"*" scoped to CloudFront edge IPs — a
						// wildcard principal, but not world-reachable.
						how += " but every such statement is restricted by a Condition"
						sev = "medium"
					}
				}
			}
		}
		if how == "" {
			continue
		}
		// Block Public Access is evaluated before any ACL or policy, so when it
		// is on the grant cannot actually be exercised.
		if blockPublicAccessOn(n.Properties) {
			how += "; blocked by S3 Block Public Access"
			sev = "low"
		}
		out = append(out, nf(n, "s3-public-bucket", sev, "data-exposure",
			"S3 bucket is publicly readable ("+how+")",
			"Remove public grants, delete the policy's wildcard allow, enable S3 Block Public Access"))
	}
	return out
}

type policyDoc struct {
	Statement []struct {
		Effect    string          `json:"Effect"`
		Principal json.RawMessage `json:"Principal"`
		Condition json.RawMessage `json:"Condition"`
	} `json:"Statement"`
}

// anonymousPolicyGrant reports whether a bucket policy has any Allow statement
// with a wildcard principal, and whether *every* such statement carries a
// Condition. Substring-matching `"*"` misfires on wildcard Actions and Resources
// and cannot see conditions at all, so the document is parsed properly.
func anonymousPolicyGrant(policy string) (anon bool, allConditioned bool) {
	var doc policyDoc
	if err := json.Unmarshal([]byte(policy), &doc); err != nil {
		// Unparseable policy: fall back to the conservative substring signal.
		return strings.Contains(policy, `"*"`) && strings.Contains(policy, "Allow"), false
	}
	allConditioned = true
	for _, st := range doc.Statement {
		if !strings.EqualFold(st.Effect, "Allow") || !wildcardPrincipal(st.Principal) {
			continue
		}
		anon = true
		if len(st.Condition) == 0 || string(st.Condition) == "null" || string(st.Condition) == "{}" {
			allConditioned = false
		}
	}
	if !anon {
		return false, false
	}
	return true, allConditioned
}

// grantScope describes what an anonymous grant actually permits.
type grantScope struct {
	list  bool // can enumerate object keys (s3:ListBucket)
	write bool // can modify or delete objects
}

// anonymousGrantScope inspects the actions granted to wildcard principals. A
// public bucket serving a static site (GetObject only) is a different risk from
// one that can be listed or written to.
func anonymousGrantScope(policy string) grantScope {
	var doc struct {
		Statement []struct {
			Effect    string          `json:"Effect"`
			Principal json.RawMessage `json:"Principal"`
			Action    json.RawMessage `json:"Action"`
		} `json:"Statement"`
	}
	var scope grantScope
	if err := json.Unmarshal([]byte(policy), &doc); err != nil {
		// Cannot tell — assume the worst rather than under-reporting.
		return grantScope{list: true, write: true}
	}
	for _, st := range doc.Statement {
		if !strings.EqualFold(st.Effect, "Allow") || !wildcardPrincipal(st.Principal) {
			continue
		}
		for _, a := range jsonStrings(st.Action) {
			lower := strings.ToLower(a)
			switch {
			case lower == "*" || lower == "s3:*":
				scope.list, scope.write = true, true
			case strings.HasPrefix(lower, "s3:list"):
				scope.list = true
			case strings.HasPrefix(lower, "s3:put"), strings.HasPrefix(lower, "s3:delete"),
				strings.HasPrefix(lower, "s3:restore"), strings.Contains(lower, "acl"):
				scope.write = true
			}
		}
	}
	return scope
}

// wildcardPrincipal matches both `"Principal": "*"` and
// `"Principal": {"AWS": "*"}` (including the list form).
func wildcardPrincipal(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s == "*"
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return false
	}
	for _, v := range obj {
		var one string
		if json.Unmarshal(v, &one) == nil {
			if one == "*" {
				return true
			}
			continue
		}
		var many []string
		if json.Unmarshal(v, &many) == nil {
			for _, m := range many {
				if m == "*" {
					return true
				}
			}
		}
	}
	return false
}

// blockPublicAccessOn reports whether the two settings that actually neutralise
// a public grant (policy + ACL restriction) are both enabled.
func blockPublicAccessOn(props map[string]any) bool {
	policyBlocked, _ := props["block_public_policy"].(bool)
	restricted, _ := props["restrict_public_buckets"].(bool)
	return policyBlocked && restricted
}

func ruleOpenIngress(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("SG") {
		rules, ok := n.Properties["ingress_rules"].([]any)
		if !ok {
			continue
		}
		worst := ""
		var worstMsg string
		for _, r := range rules {
			m, _ := r.(map[string]any)
			cidr, _ := m["cidr"].(string)
			if cidr != "0.0.0.0/0" && cidr != "::/0" {
				continue
			}
			sev, why := ingressSeverity(m)
			msg := fmt.Sprintf("Security group allows inbound from any IP: %s proto=%v ports=%v→%v (%s)",
				cidr, m["protocol"], m["from"], m["to"], why)
			if severityRank[sev] > severityRank[worst] {
				worst, worstMsg = sev, msg
			}
		}
		if worst != "" {
			out = append(out, nf(n, "sg-open-ingress", worst, "network-exposure", worstMsg,
				"Restrict ingress to known CIDRs or security-group references"))
		}
	}
	return out
}

// sensitivePorts should never be reachable from the whole internet. Ports 80 and
// 443 usually should be (that's what a public load balancer is for), so open
// ingress there is expected rather than a high-severity finding.
var sensitivePorts = map[int]string{
	22: "SSH", 23: "telnet", 135: "RPC", 139: "NetBIOS", 445: "SMB",
	1433: "MSSQL", 1521: "Oracle", 2049: "NFS", 3306: "MySQL", 3389: "RDP",
	5432: "PostgreSQL", 5984: "CouchDB", 6379: "Redis", 7001: "Cassandra",
	9200: "Elasticsearch", 9300: "Elasticsearch", 11211: "memcached", 27017: "MongoDB",
}

func portValue(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int32:
		return int(t), true
	}
	return 0, false
}

// ingressSeverity grades a world-open rule by what it actually exposes.
func ingressSeverity(m map[string]any) (string, string) {
	proto, _ := m["protocol"].(string)
	from, okFrom := portValue(m["from"])
	to, okTo := portValue(m["to"])

	// "-1" means every protocol and every port.
	if proto == "-1" || !okFrom || !okTo {
		return "critical", "all ports open to the internet"
	}
	if from == 0 && to == 65535 {
		return "critical", "all ports open to the internet"
	}
	var hit []string
	for p, name := range sensitivePorts {
		if p >= from && p <= to {
			hit = append(hit, name)
		}
	}
	if len(hit) > 0 {
		sort.Strings(hit)
		return "critical", "exposes " + strings.Join(hit, ", ")
	}
	if from == to && (from == 80 || from == 443) {
		return "low", "public web port, normal for an internet-facing load balancer"
	}
	return "high", "non-standard port range open to the internet"
}

func ruleOrphanSG(g *Graph) []Finding {
	used := map[string]bool{}
	for _, e := range g.Edges {
		if e.Type == "ASSOC_WITH" {
			used[e.To] = true
		}
	}
	var out []Finding
	for _, n := range g.NodesWithLabel("SG") {
		if used[n.Key] {
			continue
		}
		out = append(out, nf(n, "sg-orphan", "low", "hygiene",
			"Security group is defined but nothing attaches to it",
			"Attach the SG where needed or delete it"))
	}
	return out
}

func ruleUnencryptedStorage(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.Nodes {
		switch n.Label {
		case "VOLUME", "RDS", "REDSHIFT":
		default:
			continue
		}
		enc, ok := n.Properties["encrypted"].(bool)
		if ok && !enc {
			out = append(out, nf(n, "unencrypted-storage", "medium", "encryption",
				fmt.Sprintf("%s is not encrypted", resourceDesc(n)),
				"Enable encryption at rest (or migrate to an encrypted resource)"))
		}
	}
	return out
}

func ruleUnassociatedResources(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("EIP") {
		inst, _ := n.Properties["instance_id"].(string)
		eni, _ := n.Properties["network_interface_id"].(string)
		if inst == "" && eni == "" {
			ev := map[string]any{}
			if v, ok := n.Properties["public_ip"]; ok {
				ev["public_ip"] = v
			}
			out = append(out, nfEv(n, "eip-unassociated", "medium", "cost",
				"Elastic IP allocated but not associated (billable idle address)", "release the EIP or associate it", ev))
		}
	}
	attached := map[string]bool{}
	for _, e := range g.Edges {
		if e.Type == "ATTACHED_TO" {
			attached[e.From] = true
		}
		if e.Type == "ATTACHES" && e.From != "" {
			attached[e.To] = true
		}
	}
	for _, n := range g.NodesWithLabel("ENI") {
		if attached[n.Key] {
			continue
		}
		// Most ENIs belong to a managed service (ELB, Lambda, VPC endpoint, RDS,
		// ECS task) rather than to an instance. Those are attached and in use —
		// only "available" means genuinely dangling. Older snapshots predate the
		// status property; treat an unknown status as in-use rather than
		// reporting every service ENI as garbage.
		status, ok := n.Properties["status"].(string)
		if !ok || !strings.EqualFold(status, "available") {
			continue
		}
		out = append(out, nf(n, "eni-unattached", "low", "hygiene",
			"Network interface is in 'available' state, attached to nothing",
			"Attach or delete the ENI"))
	}
	return out
}

// tagAwareLabels are the labels whose walkers actually retrieve tags. Only the
// EC2-family Describe* calls return tags inline; IAM, Lambda, ELBv2, ECR and S3
// need separate tag API calls the walkers don't make yet. Flagging those as
// "missing tags" reports a scanner gap as a governance problem.
var tagAwareLabels = map[string]bool{
	"EC2": true, "VPC": true, "SUBNET": true, "SG": true, "ENI": true,
	"VOLUME": true, "ROUTETABLE": true, "NACL": true, "IGW": true,
	"EIP": true, "AMI": true, "VPCPEERING": true, "FLOWLOG": true,
}

// lookupTag resolves a tag case-insensitively across the spellings teams
// actually use ("env" vs "Environment"), since AWS tag keys are case-sensitive
// and no convention is universal.
func lookupTag(tags map[string]string, candidates ...string) (string, bool) {
	for k, v := range tags {
		lk := strings.ToLower(k)
		for _, c := range candidates {
			if lk == c {
				return v, true
			}
		}
	}
	return "", false
}

func ruleMissingTags(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.Nodes {
		if !tagAwareLabels[n.Label] {
			continue
		}
		var missing []string
		if _, ok := lookupTag(n.Tags, "env", "environment"); !ok {
			missing = append(missing, "Environment")
		}
		if _, ok := lookupTag(n.Tags, "name"); !ok {
			missing = append(missing, "Name")
		}
		if len(missing) == 0 {
			continue
		}
		out = append(out, nf(n, "missing-tags", "low", "governance",
			resourceDesc(n)+" missing mandatory tags: "+strings.Join(missing, ", "),
			"Add Environment and Name tags"))
	}
	return out
}

func ruleCrossEnvEdge(g *Graph) []Finding {
	traffic := map[string]bool{
		"ASSOC_WITH": true, "REFERENCES": true, "FORWARDS": true, "CONTAINS": true,
		"ROUTES_TO": true, "ATTACHED_TO": true, "ATTACHES": true, "IN_SUBNET": true,
		"IN_VPC": true, "PART_OF": true, "APPLIES_TO": true, "USES_SUBGRP": true,
		"CONNECTS": true,
	}
	var out []Finding
	for _, e := range g.Edges {
		if !traffic[e.Type] {
			continue
		}
		from, ok1 := g.Node(e.From)
		to, ok2 := g.Node(e.To)
		if !ok1 || !ok2 {
			continue
		}
		fe, fok := lookupTag(from.Tags, "env", "environment")
		te, tok := lookupTag(to.Tags, "env", "environment")
		if !fok || !tok || strings.EqualFold(fe, te) {
			continue
		}
		out = append(out, nf(from, "cross-env-edge", "high", "isolation",
			fmt.Sprintf("%s (%s/%s) edge %s reaches %s (%s/%s) across environments",
				from.Label, from.Key, fe, e.Type, to.Label, to.Key, te),
			"Segregate environments into separate VPCs/accounts or remove the cross-env link"))
	}
	return out
}

func ruleCostIdle(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("EC2") {
		if state, _ := n.Properties["state"].(string); state == "stopped" {
			out = append(out, nf(n, "idle-resource", "medium", "cost",
				"EC2 instance is stopped (no longer consuming run cost, still billable storage)",
				"Terminate the instance to release EBS volume costs"))
		}
	}
	return out
}

func ruleFlowLogsDisabled(g *Graph) []Finding {
	hasFlow := map[string]bool{}
	for _, e := range g.Edges {
		if e.Type == "FLOWS_ON" {
			hasFlow[e.To] = true
		}
	}
	var out []Finding
	for _, n := range g.NodesWithLabel("VPC") {
		if hasFlow[n.Key] {
			continue
		}
		out = append(out, nf(n, "vpc-flow-logs-disabled", "medium", "observability",
			"VPC has no flow logs enabled",
			"Enable VPC Flow Logs to a CloudWatch Logs group or S3"))
	}
	return out
}

type iamDoc struct {
	Statement []struct {
		Effect    string          `json:"Effect"`
		Action    json.RawMessage `json:"Action"`
		Resource  json.RawMessage `json:"Resource"`
		Principal json.RawMessage `json:"Principal"`
		Condition json.RawMessage `json:"Condition"`
	} `json:"Statement"`
}

// jsonStrings normalises the string-or-list shape AWS policy documents use for
// Action, Resource and NotAction.
func jsonStrings(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return []string{one}
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return many
	}
	return nil
}

func hasBare(vals []string, want string) bool {
	for _, v := range vals {
		if v == want {
			return true
		}
	}
	return false
}

// ruleIamWildcardAdmin flags customer-managed policies that grant every action,
// which makes any principal holding them an account administrator.
func ruleIamWildcardAdmin(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("IAMPOLICY") {
		raw, _ := n.Properties["document"].(string)
		if raw == "" {
			continue
		}
		var doc iamDoc
		if json.Unmarshal([]byte(raw), &doc) != nil {
			continue
		}
		for _, st := range doc.Statement {
			if !strings.EqualFold(st.Effect, "Allow") || !hasBare(jsonStrings(st.Action), "*") {
				continue
			}
			sev, scope := "high", "every action"
			if hasBare(jsonStrings(st.Resource), "*") {
				sev, scope = "critical", "every action on every resource"
			}
			name, _ := n.Properties["policy_name"].(string)
			if name == "" {
				name = n.Key
			}
			out = append(out, nf(n, "iam-wildcard-admin", sev, "iam",
				"Customer-managed policy "+name+" grants "+scope,
				"Replace the wildcard with the specific actions and resource ARNs the principal needs"))
			break
		}
	}
	return out
}

// ruleIamTrustWildcard flags roles any AWS principal can assume. Without a
// Condition (ExternalId, aws:PrincipalOrgID, source ARN) this is an
// account-boundary hole, not just loose hygiene.
func ruleIamTrustWildcard(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("IAMROLE") {
		raw, _ := n.Properties["trust_policy"].(string)
		if raw == "" {
			continue
		}
		var doc iamDoc
		if json.Unmarshal([]byte(raw), &doc) != nil {
			continue
		}
		for _, st := range doc.Statement {
			if !strings.EqualFold(st.Effect, "Allow") || !wildcardPrincipal(st.Principal) {
				continue
			}
			conditioned := len(st.Condition) > 0 && string(st.Condition) != "null" && string(st.Condition) != "{}"
			sev, note := "critical", "any AWS principal can assume this role"
			if conditioned {
				sev, note = "medium", "wildcard trust principal, restricted by a Condition"
			}
			name, _ := n.Properties["role_name"].(string)
			if name == "" {
				name = n.Key
			}
			out = append(out, nf(n, "iam-trust-wildcard", sev, "iam",
				"Role "+name+" trust policy: "+note,
				"Scope the trust policy to specific account/role ARNs, or add an ExternalId / PrincipalOrgID condition"))
			break
		}
	}
	return out
}

func resourceDesc(n model.Node) string {
	if n.Name != "" {
		return n.Label + " " + n.Name
	}
	return n.Label
}

func nf(n model.Node, rule, sev, category, message, remediation string) Finding {
	return nfEv(n, rule, sev, category, message, remediation, nil)
}

func nfEv(n model.Node, rule, sev, category, message, remediation string, ev map[string]any) Finding {
	return Finding{
		Kind: "finding", ID: rule + "||" + n.Key,
		Rule: rule, Severity: sev, Category: category,
		ResourceLabel: n.Label, ResourceKey: n.Key, ResourceName: n.Name,
		AccountID: n.AccountID, Region: n.Region, SnapshotID: n.SnapshotID,
		Message: message, Remediation: remediation, Evidence: ev,
	}
}
