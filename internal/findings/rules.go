package findings

import (
	"fmt"
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
		if how == "" {
			if policy, ok := n.Properties["bucket_policy"].(string); ok && policy != "" && strings.Contains(policy, `"*"`) && strings.Contains(policy, "Allow") {
				how = "bucket policy grants anonymous principals"
			}
		}
		if how != "" {
			out = append(out, nf(n, "s3-public-bucket", "critical", "data-exposure",
				"S3 bucket is publicly readable ("+how+")",
				"Remove public grants, delete the policy's wildcard allow, enable S3 Block Public Access"))
		}
	}
	return out
}

func ruleOpenIngress(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("SG") {
		rules, ok := n.Properties["ingress_rules"].([]any)
		if !ok {
			continue
		}
		for _, r := range rules {
			m, _ := r.(map[string]any)
			cidr, _ := m["cidr"].(string)
			if cidr != "0.0.0.0/0" && cidr != "::/0" {
				continue
			}
			out = append(out, nf(n, "sg-open-ingress", "high", "network-exposure",
				fmt.Sprintf("Security group allows inbound from any IP: %s proto=%v ports=%v→%v", cidr, m["protocol"], m["from"], m["to"]),
				"Restrict ingress to known CIDRs or security-group references"))
			break
		}
	}
	return out
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
		out = append(out, nf(n, "eni-unattached", "low", "hygiene",
			"Network interface not attached to any instance",
			"Attach or delete the ENI"))
	}
	return out
}

func ruleMissingTags(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.Nodes {
		var missing []string
		tags := n.Tags
		if _, ok := tags["env"]; !ok {
			missing = append(missing, "env")
		}
		if _, ok := tags["Name"]; !ok {
			missing = append(missing, "Name")
		}
		if len(missing) == 0 {
			continue
		}
		out = append(out, nf(n, "missing-tags", "low", "governance",
			resourceDesc(n)+" missing mandatory tags: "+strings.Join(missing, ", "),
			"Add env and Name tags"))
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
		fe, fok := from.Tags["env"]
		te, tok := to.Tags["env"]
		if !fok || !tok || fe == te {
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
