package findings

import (
	"testing"

	"awsome/internal/model"
)

func sg(key, name string, ingress, egress []any) model.Node {
	return model.Node{Label: "SG", Key: key, Name: name, Properties: map[string]any{
		"group_name": name, "ingress_rules": ingress, "egress_rules": egress,
	}}
}

func rule(cidr, proto string, from, to any) map[string]any {
	return map[string]any{"cidr": cidr, "protocol": proto, "from": from, "to": to}
}

func TestEgressEstablishedTunnel(t *testing.T) {
	g := graphOf(
		// no ingress + dials the internet + reaches an internal service port
		sg("sg-tunnel", "tunnel", nil, []any{
			rule("0.0.0.0/0", "tcp", 443.0, 443.0),
			rule("172.31.0.0/16", "tcp", 8088.0, 8088.0),
		}),
		// plain unrestricted egress is ordinary and must not fire
		sg("sg-plain", "plain", nil, []any{rule("0.0.0.0/0", "-1", nil, nil)}),
		// internal reach without internet egress is not a tunnel
		sg("sg-internal", "internal", nil, []any{rule("172.31.0.0/16", "tcp", 8088.0, 8088.0)}),
		// something admits traffic, so the normal exposure chain applies
		sg("sg-normal", "normal", []any{rule("10.0.0.0/8", "tcp", 443.0, 443.0)}, []any{
			rule("0.0.0.0/0", "tcp", 443.0, 443.0),
			rule("172.31.0.0/16", "tcp", 8088.0, 8088.0),
		}),
	)

	got := map[string]bool{}
	for _, f := range ruleEgressEstablishedTunnel(g) {
		got[f.ResourceKey] = true
	}
	if !got["sg-tunnel"] {
		t.Error("a group with no ingress, internet egress and internal service reach should be flagged")
	}
	for _, quiet := range []string{"sg-plain", "sg-internal", "sg-normal"} {
		if got[quiet] {
			t.Errorf("%s must not be flagged", quiet)
		}
	}
}

func TestBastionWithDataTierReach(t *testing.T) {
	host := model.Node{Label: "EC2", Key: "i-bastion", Name: "bastion", Properties: map[string]any{
		"public_ip": "203.0.113.5", "state": "running", "has_instance_profile": false,
	}}
	private := model.Node{Label: "EC2", Key: "i-private", Name: "private", Properties: map[string]any{
		"state": "running",
	}}
	ssh := sg("sg-ssh", "ssh", []any{rule("198.51.100.7/32", "tcp", 22.0, 22.0)}, nil)
	db := sg("sg-db", "db", []any{rule("10.0.0.0/8", "tcp", 5432.0, 5432.0)}, nil)
	webOnly := sg("sg-web", "web", []any{rule("0.0.0.0/0", "tcp", 443.0, 443.0)}, nil)

	g := graphOf(host, private, ssh, db, webOnly)
	g.Edges = []model.Edge{
		{From: "i-bastion", To: "sg-ssh", Type: "ASSOC_WITH"},
		{From: "i-bastion", To: "sg-db", Type: "ASSOC_WITH"},
		{From: "i-private", To: "sg-db", Type: "ASSOC_WITH"},
	}

	out := ruleBastionWithDataTierReach(g)
	if len(out) != 1 || out[0].ResourceKey != "i-bastion" {
		t.Fatalf("expected only the public host with database reach, got %+v", out)
	}
	if ev, _ := out[0].Evidence["database_reach"].([]string); len(ev) == 0 {
		t.Error("finding should name which database ports are reachable")
	}

	// A public host with no database reach is an ordinary web server.
	g2 := graphOf(host, webOnly)
	g2.Edges = []model.Edge{{From: "i-bastion", To: "sg-web", Type: "ASSOC_WITH"}}
	if out := ruleBastionWithDataTierReach(g2); len(out) != 0 {
		t.Errorf("a public host without database reach must not be flagged, got %+v", out)
	}

	// A private host with database reach is the normal application pattern.
	g3 := graphOf(private, db)
	g3.Edges = []model.Edge{{From: "i-private", To: "sg-db", Type: "ASSOC_WITH"}}
	if out := ruleBastionWithDataTierReach(g3); len(out) != 0 {
		t.Errorf("a private host with database reach must not be flagged, got %+v", out)
	}
}

func TestFlatInternalSecurityGroup(t *testing.T) {
	g := graphOf(
		sg("sg-flat", "flat", []any{rule("172.31.0.0/16", "-1", nil, nil)}, nil),
		sg("sg-range", "range", []any{rule("10.0.0.0/8", "tcp", 0.0, 65535.0)}, nil),
		// a scoped internal rule is the intended pattern
		sg("sg-scoped", "scoped", []any{rule("10.0.0.0/8", "tcp", 5432.0, 5432.0)}, nil),
		// all-ports from the world is sg-open-ingress' job, not this rule's
		sg("sg-world", "world", []any{rule("0.0.0.0/0", "-1", nil, nil)}, nil),
	)

	got := map[string]bool{}
	for _, f := range ruleFlatInternalSecurityGroup(g) {
		got[f.ResourceKey] = true
	}
	if !got["sg-flat"] || !got["sg-range"] {
		t.Error("all-port internal rules should be flagged")
	}
	if got["sg-scoped"] || got["sg-world"] {
		t.Error("scoped internal rules and world-facing rules must not be flagged here")
	}
}

func TestPrivateCIDR(t *testing.T) {
	for _, c := range []string{"10.0.0.0/8", "172.16.0.0/12", "172.31.0.0/16", "192.168.1.0/24"} {
		if !privateCIDR(c) {
			t.Errorf("%s should be private", c)
		}
	}
	for _, c := range []string{"0.0.0.0/0", "203.0.113.0/24", "8.8.8.8/32"} {
		if privateCIDR(c) {
			t.Errorf("%s should not be treated as private", c)
		}
	}
}
