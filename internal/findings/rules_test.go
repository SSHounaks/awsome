package findings

import (
	"testing"

	"awsome/internal/model"
)

func graphOf(nodes ...model.Node) *Graph {
	g := &Graph{byKey: map[string]model.Node{}}
	for _, n := range nodes {
		g.Nodes = append(g.Nodes, n)
		g.byKey[n.Key] = n
	}
	return g
}

func iamPolicy(name, doc string) model.Node {
	return model.Node{
		Label:      "IAMPOLICY",
		Key:        "arn:aws-us-gov:iam::1:policy/" + name,
		Properties: map[string]any{"policy_name": name, "document": doc},
	}
}

func iamRole(name, trust string) model.Node {
	return model.Node{
		Label:      "IAMROLE",
		Key:        "arn:aws-us-gov:iam::1:role/" + name,
		Properties: map[string]any{"role_name": name, "trust_policy": trust},
	}
}

func TestRuleIamWildcardAdmin(t *testing.T) {
	g := graphOf(
		iamPolicy("full-admin", `{"Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}`),
		iamPolicy("all-actions-scoped", `{"Statement":[{"Effect":"Allow","Action":"*","Resource":"arn:aws-us-gov:s3:::b/*"}]}`),
		iamPolicy("service-wildcard", `{"Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*"}]}`),
		iamPolicy("scoped", `{"Statement":[{"Effect":"Allow","Action":["lambda:GetFunction"],"Resource":"arn:aws-us-gov:lambda:::f"}]}`),
		iamPolicy("deny-all", `{"Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}`),
	)

	got := map[string]string{}
	for _, f := range ruleIamWildcardAdmin(g) {
		got[f.ResourceKey] = f.Severity
	}

	if len(got) != 2 {
		t.Fatalf("expected 2 findings, got %d: %v", len(got), got)
	}
	if sev := got["arn:aws-us-gov:iam::1:policy/full-admin"]; sev != "critical" {
		t.Errorf("full-admin severity = %q, want critical", sev)
	}
	if sev := got["arn:aws-us-gov:iam::1:policy/all-actions-scoped"]; sev != "high" {
		t.Errorf("all-actions-scoped severity = %q, want high", sev)
	}
	// "s3:*" is service-wide, not account-admin, and must not be flagged here.
	if _, ok := got["arn:aws-us-gov:iam::1:policy/service-wildcard"]; ok {
		t.Error("service-scoped wildcard should not be flagged as account admin")
	}
}

func TestRuleIamTrustWildcard(t *testing.T) {
	g := graphOf(
		iamRole("open", `{"Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":"sts:AssumeRole"}]}`),
		iamRole("conditioned", `{"Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"sts:ExternalId":"x"}}}]}`),
		iamRole("service", `{"Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}`),
	)

	got := map[string]string{}
	for _, f := range ruleIamTrustWildcard(g) {
		got[f.ResourceKey] = f.Severity
	}

	if sev := got["arn:aws-us-gov:iam::1:role/open"]; sev != "critical" {
		t.Errorf("open trust severity = %q, want critical", sev)
	}
	if sev := got["arn:aws-us-gov:iam::1:role/conditioned"]; sev != "medium" {
		t.Errorf("conditioned trust severity = %q, want medium", sev)
	}
	if _, ok := got["arn:aws-us-gov:iam::1:role/service"]; ok {
		t.Error("a service principal is not a wildcard principal")
	}
}

func TestRuleMissingTagsSkipsLabelsWithoutTagCollection(t *testing.T) {
	g := graphOf(
		model.Node{Label: "IAMROLE", Key: "role-1"},
		model.Node{Label: "LAMBDA", Key: "fn-1"},
		model.Node{Label: "EC2", Key: "i-1", Tags: map[string]string{"Environment": "alpha1", "Name": "web"}},
		model.Node{Label: "EC2", Key: "i-2"},
	)

	out := ruleMissingTags(g)
	if len(out) != 1 {
		t.Fatalf("expected only the untagged EC2 to be flagged, got %d: %+v", len(out), out)
	}
	if out[0].ResourceKey != "i-2" {
		t.Errorf("flagged %q, want i-2", out[0].ResourceKey)
	}
}

func TestRuleUnattachedENIIgnoresServiceOwnedInterfaces(t *testing.T) {
	g := graphOf(
		model.Node{Label: "ENI", Key: "eni-lb", Properties: map[string]any{"status": "in-use", "interface_type": "network_load_balancer"}},
		model.Node{Label: "ENI", Key: "eni-free", Properties: map[string]any{"status": "available", "interface_type": "interface"}},
		model.Node{Label: "ENI", Key: "eni-legacy", Properties: map[string]any{}},
	)

	var keys []string
	for _, f := range ruleUnassociatedResources(g) {
		if f.Rule == "eni-unattached" {
			keys = append(keys, f.ResourceKey)
		}
	}

	if len(keys) != 1 || keys[0] != "eni-free" {
		t.Errorf("flagged %v, want only eni-free", keys)
	}
}

func TestAnonymousPolicyGrant(t *testing.T) {
	cases := []struct {
		name            string
		policy          string
		wantAnon        bool
		wantConditioned bool
	}{
		{
			name:     "wildcard principal with no condition is public",
			policy:   `{"Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject"}]}`,
			wantAnon: true,
		},
		{
			name:            "wildcard principal scoped by SourceIp is not world-reachable",
			policy:          `{"Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Condition":{"IpAddress":{"aws:SourceIp":["13.32.0.0/15"]}}}]}`,
			wantAnon:        true,
			wantConditioned: true,
		},
		{
			name:     "AWS object form of wildcard principal",
			policy:   `{"Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":"s3:GetObject"}]}`,
			wantAnon: true,
		},
		{
			name:     "wildcard inside a principal list",
			policy:   `{"Statement":[{"Effect":"Allow","Principal":{"AWS":["arn:aws:iam::1:root","*"]},"Action":"s3:*"}]}`,
			wantAnon: true,
		},
		{
			name:     "wildcard action is not a wildcard principal",
			policy:   `{"Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::1:root"},"Action":"*"}]}`,
			wantAnon: false,
		},
		{
			name:     "explicit deny with wildcard principal is not a grant",
			policy:   `{"Statement":[{"Effect":"Deny","Principal":"*","Action":"s3:*"}]}`,
			wantAnon: false,
		},
		{
			name:            "one unconditioned statement makes the bucket public",
			policy:          `{"Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Condition":{"IpAddress":{"aws:SourceIp":["1.2.3.0/24"]}}},{"Effect":"Allow","Principal":"*","Action":"s3:List*"}]}`,
			wantAnon:        true,
			wantConditioned: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			anon, conditioned := anonymousPolicyGrant(tc.policy)
			if anon != tc.wantAnon {
				t.Errorf("anon = %v, want %v", anon, tc.wantAnon)
			}
			if anon && conditioned != tc.wantConditioned {
				t.Errorf("conditioned = %v, want %v", conditioned, tc.wantConditioned)
			}
		})
	}
}

func TestIngressSeverity(t *testing.T) {
	cases := []struct {
		name string
		rule map[string]any
		want string
	}{
		{"ssh open to world", map[string]any{"protocol": "tcp", "from": 22.0, "to": 22.0}, "critical"},
		{"postgres open to world", map[string]any{"protocol": "tcp", "from": 5432.0, "to": 5432.0}, "critical"},
		{"all protocols", map[string]any{"protocol": "-1"}, "critical"},
		{"full port range", map[string]any{"protocol": "tcp", "from": 0.0, "to": 65535.0}, "critical"},
		{"range swallowing rdp", map[string]any{"protocol": "tcp", "from": 3000.0, "to": 4000.0}, "critical"},
		{"https is expected on a public lb", map[string]any{"protocol": "tcp", "from": 443.0, "to": 443.0}, "low"},
		{"http is expected on a public lb", map[string]any{"protocol": "tcp", "from": 80.0, "to": 80.0}, "low"},
		{"odd app port", map[string]any{"protocol": "tcp", "from": 8080.0, "to": 8080.0}, "high"},
		{"missing ports are treated as everything", map[string]any{"protocol": "tcp"}, "critical"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, why := ingressSeverity(tc.rule)
			if got != tc.want {
				t.Errorf("ingressSeverity() = %q (%s), want %q", got, why, tc.want)
			}
			if why == "" {
				t.Error("expected a non-empty explanation")
			}
		})
	}
}

func TestLookupTag(t *testing.T) {
	tags := map[string]string{"Environment": "alpha1", "Name": "web"}

	if v, ok := lookupTag(tags, "env", "environment"); !ok || v != "alpha1" {
		t.Errorf("lookupTag(Environment) = %q,%v; want alpha1,true", v, ok)
	}
	if _, ok := lookupTag(tags, "owner"); ok {
		t.Error("lookupTag found a tag that is not present")
	}
	if _, ok := lookupTag(nil, "env"); ok {
		t.Error("lookupTag on nil tags should not match")
	}
}

func TestBlockPublicAccessOn(t *testing.T) {
	if !blockPublicAccessOn(map[string]any{"block_public_policy": true, "restrict_public_buckets": true}) {
		t.Error("both settings on should count as blocked")
	}
	if blockPublicAccessOn(map[string]any{"block_public_policy": true}) {
		t.Error("policy block alone should not count as blocked")
	}
	if blockPublicAccessOn(map[string]any{}) {
		t.Error("absent settings should not count as blocked")
	}
}
