package findings

import (
	"fmt"
	"sort"
	"strings"

	"awsome/internal/model"
)

/* ---------- outside-in ingress ----------
 * Exposure is a chain — gateway, route, public address, permissive group — and
 * most checks walk that chain. These rules cover the paths that bypass it
 * entirely, where every AWS-side control reads "closed" and something outside
 * still reaches in.
 */

// databasePorts are the ports whose reachability turns a foothold into data
// access. Kept separate from sensitivePorts (which grades internet exposure)
// because the question here is lateral reach, not admission from the world.
var databasePorts = map[int]string{
	1433: "MSSQL", 1521: "Oracle", 3306: "MySQL", 5432: "PostgreSQL",
	5984: "CouchDB", 6379: "Redis", 7000: "Cassandra", 9042: "Cassandra",
	9200: "Elasticsearch", 11211: "memcached", 27017: "MongoDB",
}

func ruleIngressList(n model.Node, key string) []map[string]any {
	raw, _ := n.Properties[key].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		if m, ok := r.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func isWorldCIDR(c string) bool { return c == "0.0.0.0/0" || c == "::/0" }

// privateCIDR reports whether a CIDR is RFC1918 space — an internal range rather
// than an internet source.
func privateCIDR(c string) bool {
	return strings.HasPrefix(c, "10.") || strings.HasPrefix(c, "192.168.") ||
		strings.HasPrefix(c, "172.1") || strings.HasPrefix(c, "172.2") || strings.HasPrefix(c, "172.3")
}

// ruleEgressEstablishedTunnel flags the shape of an outbound-established tunnel:
// a group that admits nothing, dials out to the internet, and can also reach
// internal service ports.
//
// This is ingress no security group, NACL, route table or gateway records. The
// session is opened outbound, so every AWS-side control reads "closed" while the
// service behind it is reachable from the internet, gated by policy held in a
// third-party product outside the account. Reverse-proxy tunnels, remote-access
// meshes and CI runners all take this form.
func ruleEgressEstablishedTunnel(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("SG") {
		if len(ruleIngressList(n, "ingress_rules")) != 0 {
			continue // something admits traffic; the normal chain applies
		}
		egress := ruleIngressList(n, "egress_rules")
		if len(egress) == 0 {
			continue
		}

		worldOut := false
		var internalPorts []string
		for _, r := range egress {
			cidr, _ := r["cidr"].(string)
			if isWorldCIDR(cidr) {
				worldOut = true
				continue
			}
			if !privateCIDR(cidr) {
				continue
			}
			// Egress to an internal *service* port is what makes the tunnel a
			// publishing path rather than plain outbound access.
			if p, ok := portValue(r["from"]); ok && p >= 1024 && p != 0 {
				internalPorts = append(internalPorts, fmt.Sprintf("%d", p))
			}
		}
		if !worldOut || len(internalPorts) == 0 {
			continue
		}
		sort.Strings(internalPorts)
		out = append(out, nfEv(n, "sg-egress-established-ingress", "high", "network-exposure",
			fmt.Sprintf("%s admits nothing inbound but dials out to the internet and can reach internal service port(s) %s — the shape of an outbound-established tunnel, which publishes those services without any inbound rule",
				resourceDesc(n), strings.Join(uniqueStrings(internalPorts), ", ")),
			"Confirm whether a tunnel or reverse proxy runs here. If so, treat it as an ingress control: evidence its authentication and authorisation policy, which lives outside this account and is invisible to AWS-side review",
			map[string]any{"internal_ports": uniqueStrings(internalPorts)}))
	}
	return out
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// ruleBastionWithDataTierReach flags an instance that is reachable from outside
// the VPC and also holds database-port reach.
//
// Either alone is ordinary: bastions exist, and application hosts reach
// databases. Together they are a pivot — one compromised host is one hop from
// the data tier, and the allowlist protecting it is usually a handful of
// operator addresses on networks nobody controls.
func ruleBastionWithDataTierReach(g *Graph) []Finding {
	// resource -> security groups
	sgsOf := map[string][]model.Node{}
	for _, e := range g.Edges {
		if e.Type != "ASSOC_WITH" {
			continue
		}
		if sg, ok := g.Node(e.To); ok && sg.Label == "SG" {
			sgsOf[e.From] = append(sgsOf[e.From], sg)
		}
	}

	var out []Finding
	for _, n := range g.NodesWithLabel("EC2") {
		ip, _ := propStr(n, "public_ip")
		if ip == "" {
			continue
		}
		if state, _ := propStr(n, "state"); state != "" && state != "running" {
			continue
		}

		var admits []string
		var reaches []string
		for _, sg := range sgsOf[n.Key] {
			for _, r := range ruleIngressList(sg, "ingress_rules") {
				cidr, _ := r["cidr"].(string)
				if cidr == "" || privateCIDR(cidr) {
					continue
				}
				// An external source — the world, or named outside addresses.
				from, okf := portValue(r["from"])
				to, okt := portValue(r["to"])
				if !okf || !okt {
					admits = append(admits, cidr+" all ports")
					continue
				}
				for p, name := range sensitivePorts {
					if p >= from && p <= to {
						admits = append(admits, fmt.Sprintf("%s from %s", name, cidr))
					}
				}
			}
			// Database reach is granted by the groups the host carries.
			for _, r := range ruleIngressList(sg, "ingress_rules") {
				from, okf := portValue(r["from"])
				to, okt := portValue(r["to"])
				if !okf || !okt {
					continue
				}
				for p, name := range databasePorts {
					if p >= from && p <= to {
						reaches = append(reaches, name)
					}
				}
			}
		}
		if len(admits) == 0 || len(reaches) == 0 {
			continue
		}
		admits, reaches = uniqueStrings(admits), uniqueStrings(reaches)
		sort.Strings(admits)
		sort.Strings(reaches)

		ev := map[string]any{"admits": admits, "database_reach": reaches, "public_ip": ip}
		if prof, ok := propBool(n, "has_instance_profile"); ok && !prof {
			ev["has_instance_profile"] = false
		}
		out = append(out, nfEv(n, "ec2-bastion-data-tier-reach", "high", "network-exposure",
			fmt.Sprintf("%s is reachable from outside the VPC (%s) and carries security groups granting %s — one host between an external allowlist and the data tier",
				resourceDesc(n), strings.Join(admits, "; "), strings.Join(reaches, ", ")),
			"Remove the public address and the database-port groups from the same host. Use SSM Session Manager for operator access so no inbound rule or standing allowlist is needed",
			ev))
	}
	return out
}

// ruleFlatInternalSecurityGroup flags a group that admits every port across a
// whole internal range. It collapses the segmentation the other groups provide:
// holding it is equivalent to holding everything it can reach, which is what
// turns an exposed host into an exposed data tier.
func ruleFlatInternalSecurityGroup(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("SG") {
		for _, r := range ruleIngressList(n, "ingress_rules") {
			cidr, _ := r["cidr"].(string)
			if cidr == "" || !privateCIDR(cidr) {
				continue
			}
			proto, _ := r["protocol"].(string)
			from, okf := portValue(r["from"])
			to, okt := portValue(r["to"])
			allPorts := proto == "-1" || !okf || !okt || (from == 0 && to == 65535)
			if !allPorts {
				continue
			}
			out = append(out, nfEv(n, "sg-flat-internal-range", "medium", "network-exposure",
				fmt.Sprintf("%s admits every port from %s, so anything inside that range reaches anything this group protects", resourceDesc(n), cidr),
				"Replace the range with security-group references naming the specific callers, and narrow to the ports actually used",
				map[string]any{"cidr": cidr}))
			break
		}
	}
	return out
}
