package findings

import (
	"testing"

	"awsome/internal/model"
)

func node(label, key string, props map[string]any) model.Node {
	return model.Node{Label: label, Key: key, Name: key, Properties: props}
}

func rulesByID(out []Finding) map[string]Finding {
	m := map[string]Finding{}
	for _, f := range out {
		m[f.Rule+"|"+f.ResourceKey] = f
	}
	return m
}

func TestRuleImdsV1(t *testing.T) {
	g := graphOf(
		node("EC2", "i-v1", map[string]any{"imds_tokens": "optional", "imds_endpoint": "enabled"}),
		node("EC2", "i-v2", map[string]any{"imds_tokens": "required", "imds_endpoint": "enabled"}),
		node("EC2", "i-off", map[string]any{"imds_tokens": "optional", "imds_endpoint": "disabled"}),
		node("EC2", "i-unknown", map[string]any{}),
		node("EC2", "i-hops", map[string]any{"imds_tokens": "required", "imds_endpoint": "enabled", "imds_hop_limit": 2.0}),
	)

	got := rulesByID(ruleImdsV1(g))

	if f, ok := got["ec2-imdsv1-enabled|i-v1"]; !ok || f.Severity != "critical" {
		t.Errorf("IMDSv1 instance should be critical, got %+v", f)
	}
	if _, ok := got["ec2-imdsv1-enabled|i-v2"]; ok {
		t.Error("IMDSv2-required instance must not be flagged")
	}
	if _, ok := got["ec2-imdsv1-enabled|i-off"]; ok {
		t.Error("instance with the metadata endpoint disabled has nothing to steal")
	}
	if _, ok := got["ec2-imdsv1-enabled|i-unknown"]; ok {
		t.Error("instance with no collected IMDS data must not be flagged")
	}
	if _, ok := got["ec2-imds-hop-limit|i-hops"]; !ok {
		t.Error("hop limit above 1 should be reported")
	}
}

func TestSecretishEnvName(t *testing.T) {
	secret := []string{"DB_PASSWORD", "API_KEY", "STRIPE_SECRET", "SESSION_KEY", "MY_TOKEN", "PRIVATE_KEY"}
	for _, s := range secret {
		if !secretishEnvName(s) {
			t.Errorf("%q should look like a secret", s)
		}
	}
	// References to a secret are the correct pattern and must not be flagged.
	notSecret := []string{"DB_SECRET_ARN", "API_KEY_NAME", "TOKEN_URL", "SECRET_ID", "DATABASE_URL", "LOG_LEVEL", "SECRETS_PATH"}
	for _, s := range notSecret {
		if secretishEnvName(s) {
			t.Errorf("%q references a secret rather than holding one; should not be flagged", s)
		}
	}
}

func TestRuleLambdaEnvSecret(t *testing.T) {
	g := graphOf(
		node("LAMBDA", "fn-bad", map[string]any{"env_var_names": []any{"DB_PASSWORD", "LOG_LEVEL"}}),
		node("LAMBDA", "fn-good", map[string]any{"env_var_names": []any{"DB_SECRET_ARN", "LOG_LEVEL"}}),
		node("LAMBDA", "fn-none", map[string]any{}),
	)

	out := ruleLambdaEnvSecret(g)
	if len(out) != 1 || out[0].ResourceKey != "fn-bad" {
		t.Fatalf("expected only fn-bad flagged, got %+v", out)
	}
	// The value must never appear anywhere in the finding.
	vars, _ := out[0].Evidence["variables"].([]string)
	if len(vars) != 1 || vars[0] != "DB_PASSWORD" {
		t.Errorf("evidence should carry the variable name only, got %v", vars)
	}
}

func TestRuleRootAccount(t *testing.T) {
	g := graphOf(node("ACCOUNT", "acct", map[string]any{
		"root_access_keys": 1.0,
		"root_mfa_enabled": false,
	}))

	got := rulesByID(ruleRootAccount(g))
	if f, ok := got["iam-root-access-key|acct"]; !ok || f.Severity != "critical" {
		t.Error("root access key must be critical")
	}
	if f, ok := got["iam-root-no-mfa|acct"]; !ok || f.Severity != "critical" {
		t.Error("root without MFA must be critical")
	}

	clean := graphOf(node("ACCOUNT", "ok", map[string]any{
		"root_access_keys": 0.0,
		"root_mfa_enabled": true,
	}))
	if out := ruleRootAccount(clean); len(out) != 0 {
		t.Errorf("a clean root account should produce no findings, got %+v", out)
	}
}

func TestRulePasswordPolicy(t *testing.T) {
	none := graphOf(node("ACCOUNT", "a", map[string]any{"password_policy": false}))
	out := rulePasswordPolicy(none)
	if len(out) != 1 || out[0].Severity != "high" {
		t.Fatalf("missing policy should be a single high finding, got %+v", out)
	}

	weak := graphOf(node("ACCOUNT", "b", map[string]any{
		"password_policy": true, "password_min_length": 8.0, "password_reuse_prevention": 0.0,
	}))
	got := rulesByID(rulePasswordPolicy(weak))
	if _, ok := got["iam-weak-password-policy|b"]; !ok {
		t.Error("8-character minimum should be flagged")
	}
	if _, ok := got["iam-password-reuse|b"]; !ok {
		t.Error("no reuse prevention should be flagged")
	}

	strong := graphOf(node("ACCOUNT", "c", map[string]any{
		"password_policy": true, "password_min_length": 14.0, "password_reuse_prevention": 24.0,
	}))
	if out := rulePasswordPolicy(strong); len(out) != 0 {
		t.Errorf("a compliant policy should produce no findings, got %+v", out)
	}
}

func TestRuleIamUserCredentials(t *testing.T) {
	g := graphOf(
		node("IAMUSER", "u-nomfa", map[string]any{
			"user_name": "alice", "console_access": true, "mfa_enabled": false,
		}),
		node("IAMUSER", "u-ok", map[string]any{
			"user_name": "bob", "console_access": true, "mfa_enabled": true,
		}),
		node("IAMUSER", "u-prog", map[string]any{
			"user_name": "ci", "console_access": false, "mfa_enabled": false,
			"active_access_keys": 2.0, "oldest_access_key_days": 400.0, "most_idle_access_key_days": 200.0,
		}),
	)

	got := rulesByID(ruleIamUserCredentials(g))

	if _, ok := got["iam-user-no-mfa|u-nomfa"]; !ok {
		t.Error("console user without MFA should be flagged")
	}
	if _, ok := got["iam-user-no-mfa|u-ok"]; ok {
		t.Error("console user with MFA must not be flagged")
	}
	// A programmatic user has no console to protect with MFA.
	if _, ok := got["iam-user-no-mfa|u-prog"]; ok {
		t.Error("programmatic-only user must not be flagged for missing console MFA")
	}
	for _, rule := range []string{"iam-user-two-keys", "iam-access-key-stale", "iam-access-key-unused"} {
		if _, ok := got[rule+"|u-prog"]; !ok {
			t.Errorf("%s should fire for the stale CI user", rule)
		}
	}
}

func TestExternalTrustAccounts(t *testing.T) {
	const self = "111111111111"

	cases := []struct {
		name        string
		policy      string
		wantExt     int
		conditioned bool
	}{
		{
			name:    "same-account trust is not external",
			policy:  `{"Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::111111111111:root"},"Action":"sts:AssumeRole"}]}`,
			wantExt: 0,
		},
		{
			name:    "service principal is not cross-account",
			policy:  `{"Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}`,
			wantExt: 0,
		},
		{
			name:    "external account, no condition",
			policy:  `{"Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::999999999999:root"},"Action":"sts:AssumeRole"}]}`,
			wantExt: 1,
		},
		{
			name:        "external account scoped by ExternalId",
			policy:      `{"Statement":[{"Effect":"Allow","Principal":{"AWS":"999999999999"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"sts:ExternalId":"x"}}}]}`,
			wantExt:     1,
			conditioned: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ext, conditioned := externalTrustAccounts(tc.policy, self)
			if len(ext) != tc.wantExt {
				t.Fatalf("external accounts = %v, want %d", ext, tc.wantExt)
			}
			if tc.wantExt > 0 && conditioned != tc.conditioned {
				t.Errorf("conditioned = %v, want %v", conditioned, tc.conditioned)
			}
		})
	}
}

func TestRuleEksPublicEndpoint(t *testing.T) {
	g := graphOf(
		node("EKSCLUSTER", "c-open", map[string]any{
			"endpoint_public_access": true, "public_access_cidrs": []any{"0.0.0.0/0"},
		}),
		node("EKSCLUSTER", "c-scoped", map[string]any{
			"endpoint_public_access": true, "public_access_cidrs": []any{"203.0.113.0/24"},
		}),
		node("EKSCLUSTER", "c-private", map[string]any{
			"endpoint_public_access": false, "endpoint_private_access": true,
		}),
	)

	got := rulesByID(ruleEksPublicEndpoint(g))
	if f := got["eks-public-endpoint|c-open"]; f.Severity != "critical" {
		t.Errorf("0.0.0.0/0 endpoint should be critical, got %q", f.Severity)
	}
	if f := got["eks-public-endpoint|c-scoped"]; f.Severity != "high" {
		t.Errorf("CIDR-scoped public endpoint should be high, got %q", f.Severity)
	}
	if _, ok := got["eks-public-endpoint|c-private"]; ok {
		t.Error("private-only cluster must not be flagged")
	}
}

func TestRuleRdsHardening(t *testing.T) {
	g := graphOf(
		node("RDS", "db-public", map[string]any{"publicly_accessible": true, "backup_retention_days": 7.0}),
		node("RDS", "db-nobackup", map[string]any{"backup_retention_days": 0.0}),
		node("RDS", "db-short", map[string]any{"backup_retention_days": 3.0}),
		// A read replica reports 0 retention by design; its source holds backups.
		node("RDS", "db-replica", map[string]any{"backup_retention_days": 0.0, "is_read_replica": true}),
		node("RDS", "db-ok", map[string]any{
			"backup_retention_days": 14.0, "deletion_protection": true,
			"auto_minor_version_upgrade": true, "publicly_accessible": false,
		}),
	)

	got := rulesByID(ruleRdsHardening(g))
	if f := got["rds-publicly-accessible|db-public"]; f.Severity != "critical" {
		t.Errorf("public RDS should be critical, got %q", f.Severity)
	}
	if f := got["rds-no-backup|db-nobackup"]; f.Severity != "high" {
		t.Errorf("zero retention should be high, got %q", f.Severity)
	}
	if f := got["rds-no-backup|db-short"]; f.Severity != "medium" {
		t.Errorf("short retention should be medium, got %q", f.Severity)
	}
	if _, ok := got["rds-no-backup|db-replica"]; ok {
		t.Error("a read replica must not be flagged for zero backup retention")
	}
	for k := range got {
		if len(k) > 6 && k[len(k)-5:] == "db-ok" {
			t.Errorf("a hardened database should produce no findings, got %s", k)
		}
	}
}

func TestRuleSgOpenEgress(t *testing.T) {
	g := graphOf(
		node("SG", "sg-open", map[string]any{
			"egress_rules": []any{map[string]any{"cidr": "0.0.0.0/0", "protocol": "-1"}},
		}),
		node("SG", "sg-scoped", map[string]any{
			"egress_rules": []any{map[string]any{"cidr": "10.0.0.0/8", "protocol": "-1"}},
		}),
		node("SG", "sg-tcp443", map[string]any{
			"egress_rules": []any{map[string]any{"cidr": "0.0.0.0/0", "protocol": "tcp", "from": 443.0, "to": 443.0}},
		}),
	)

	out := ruleSgOpenEgress(g)
	if len(out) != 1 || out[0].ResourceKey != "sg-open" {
		t.Errorf("only all-protocol egress to the internet should be flagged, got %+v", out)
	}
}
