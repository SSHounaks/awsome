package findings

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"awsome/internal/model"
)

/* ---------- property accessors ----------
 * Properties round-trip through JSON, so every number arrives as float64 and
 * every slice as []any. These normalise that.
 */

func propBool(n model.Node, key string) (bool, bool) {
	v, ok := n.Properties[key].(bool)
	return v, ok
}

func propInt(n model.Node, key string) (int, bool) {
	switch t := n.Properties[key].(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int32:
		return int(t), true
	case int64:
		return int(t), true
	}
	return 0, false
}

func propStr(n model.Node, key string) (string, bool) {
	v, ok := n.Properties[key].(string)
	return v, ok
}

func propStrSlice(n model.Node, key string) []string {
	switch t := n.Properties[key].(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, v := range t {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

/* ---------- identity ---------- */

// ruleRootAccount flags the two root-account conditions that matter most. Root
// cannot be scoped by policy, so anything holding root credentials owns the
// account outright.
func ruleRootAccount(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("ACCOUNT") {
		if keys, ok := propInt(n, "root_access_keys"); ok && keys > 0 {
			out = append(out, nf(n, "iam-root-access-key", "critical", "iam",
				"Root account has an active access key",
				"Delete the root access key; use IAM roles or Identity Center for programmatic access"))
		}
		if mfa, ok := propBool(n, "root_mfa_enabled"); ok && !mfa {
			out = append(out, nf(n, "iam-root-no-mfa", "critical", "iam",
				"Root account does not have MFA enabled",
				"Enable a hardware MFA device on the root account and store it securely"))
		}
	}
	return out
}

// rulePasswordPolicy checks the account password policy against the CIS
// thresholds (14 characters, 24 remembered passwords).
func rulePasswordPolicy(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("ACCOUNT") {
		set, known := propBool(n, "password_policy")
		if known && !set {
			out = append(out, nf(n, "iam-weak-password-policy", "high", "iam",
				"Account has no IAM password policy at all",
				"Set a password policy: minimum length 14, reuse prevention 24, and complexity requirements"))
			continue
		}
		if !set {
			continue
		}
		if length, ok := propInt(n, "password_min_length"); ok && length < 14 {
			out = append(out, nfEv(n, "iam-weak-password-policy", "medium", "iam",
				fmt.Sprintf("IAM password policy allows passwords of %d characters (minimum should be 14)", length),
				"Raise MinimumPasswordLength to at least 14",
				map[string]any{"min_length": length}))
		}
		if reuse, ok := propInt(n, "password_reuse_prevention"); !ok || reuse < 24 {
			out = append(out, nf(n, "iam-password-reuse", "low", "iam",
				"IAM password policy does not prevent reuse of the last 24 passwords",
				"Set PasswordReusePrevention to 24"))
		}
	}
	return out
}

const (
	keyAgeDays  = 90
	keyIdleDays = 90
)

// ruleIamUserCredentials covers the static-credential failure modes: console
// users without MFA, and access keys that are old, idle, or duplicated.
func ruleIamUserCredentials(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("IAMUSER") {
		name, _ := propStr(n, "user_name")
		if name == "" {
			name = n.Key
		}

		console, knownConsole := propBool(n, "console_access")
		mfa, knownMFA := propBool(n, "mfa_enabled")
		if knownConsole && console && knownMFA && !mfa {
			out = append(out, nf(n, "iam-user-no-mfa", "high", "iam",
				"User "+name+" has console access without MFA",
				"Enrol an MFA device, or remove the login profile if console access is not needed"))
		}

		if active, ok := propInt(n, "active_access_keys"); ok && active >= 2 {
			out = append(out, nfEv(n, "iam-user-two-keys", "low", "iam",
				fmt.Sprintf("User %s has %d active access keys", name, active),
				"Keep one active key; delete the other once rotation is complete",
				map[string]any{"active_access_keys": active}))
		}

		if age, ok := propInt(n, "oldest_access_key_days"); ok && age > keyAgeDays {
			out = append(out, nfEv(n, "iam-access-key-stale", "medium", "iam",
				fmt.Sprintf("User %s has an active access key %d days old", name, age),
				fmt.Sprintf("Rotate access keys at least every %d days, or replace them with a role", keyAgeDays),
				map[string]any{"age_days": age}))
		}

		// A key nobody uses is a credential nobody would notice being used.
		if idle, ok := propInt(n, "most_idle_access_key_days"); ok && idle > keyIdleDays {
			if active, _ := propInt(n, "active_access_keys"); active > 0 {
				out = append(out, nfEv(n, "iam-access-key-unused", "medium", "iam",
					fmt.Sprintf("User %s has an active access key unused for %d days", name, idle),
					"Deactivate and delete unused keys",
					map[string]any{"idle_days": idle}))
			}
		}
	}
	return out
}

// ruleIamExternalTrust flags roles trusting a principal in another AWS account
// without a Condition. Without an ExternalId or PrincipalOrgID this is the
// classic confused-deputy setup.
func ruleIamExternalTrust(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("IAMROLE") {
		raw, _ := propStr(n, "trust_policy")
		if raw == "" {
			continue
		}
		selfAccount := n.AccountID
		externals, conditioned := externalTrustAccounts(raw, selfAccount)
		if len(externals) == 0 || conditioned {
			continue
		}
		name, _ := propStr(n, "role_name")
		if name == "" {
			name = n.Key
		}
		out = append(out, nfEv(n, "iam-cross-account-trust", "high", "iam",
			fmt.Sprintf("Role %s can be assumed by ANY principal in external account(s) %s — the trust names the account root, not a specific role, and carries no Condition",
				name, strings.Join(externals, ", ")),
			"Name the specific external role ARN that needs to assume this role, or add an aws:PrincipalOrgID / ExternalId condition",
			map[string]any{"external_accounts": externals}))
	}
	return out
}

// trustPrincipal is one AWS principal in a trust policy.
type trustPrincipal struct {
	account string
	// scoped is true when the principal names a specific role or user. Naming
	// one role ARN is the tightest form of cross-account trust there is — it is
	// what "scope the trust" means — so it must not be reported as unscoped.
	// Only ":root" or a bare account id lets *any* principal in that account
	// assume the role.
	scoped bool
}

// externalTrustAccounts returns the AWS accounts outside selfAccount that can
// assume the role via an *unscoped* principal and without a Condition. A trust
// naming a specific external role ARN is already correctly constrained and is
// not returned.
func externalTrustAccounts(policy, selfAccount string) (accounts []string, allConditioned bool) {
	var doc iamDoc
	if json.Unmarshal([]byte(policy), &doc) != nil {
		return nil, false
	}
	seen := map[string]bool{}
	allConditioned = true
	for _, st := range doc.Statement {
		if !strings.EqualFold(st.Effect, "Allow") {
			continue
		}
		var external []string
		for _, p := range principalAccounts(st.Principal) {
			if p.account == "" || p.account == selfAccount || p.scoped {
				continue
			}
			external = append(external, p.account)
		}
		if len(external) == 0 {
			continue
		}
		if len(st.Condition) == 0 || string(st.Condition) == "null" || string(st.Condition) == "{}" {
			allConditioned = false
		}
		for _, e := range external {
			if !seen[e] {
				seen[e] = true
				accounts = append(accounts, e)
			}
		}
	}
	sort.Strings(accounts)
	return accounts, allConditioned
}

// principalAccounts pulls principals out of the "AWS" key of a Principal block,
// which may be a bare account id or a full ARN, singular or a list.
func principalAccounts(raw json.RawMessage) []trustPrincipal {
	if len(raw) == 0 {
		return nil
	}
	var out []trustPrincipal
	add := func(s string) {
		if s == "" || s == "*" {
			return
		}
		if strings.HasPrefix(s, "arn:") {
			parts := strings.Split(s, ":")
			if len(parts) < 6 {
				return
			}
			// parts[5] is "root" for the account principal, or "role/x", "user/x".
			out = append(out, trustPrincipal{account: parts[4], scoped: parts[5] != "root"})
			return
		}
		// A bare 12-digit account id is equivalent to :root.
		if len(s) == 12 && strings.Trim(s, "0123456789") == "" {
			out = append(out, trustPrincipal{account: s})
		}
	}

	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return nil
	}
	for key, v := range obj {
		if !strings.EqualFold(key, "AWS") {
			continue // Service/Federated principals are not cross-account trust
		}
		var one string
		if json.Unmarshal(v, &one) == nil {
			add(one)
			continue
		}
		var many []string
		if json.Unmarshal(v, &many) == nil {
			for _, m := range many {
				add(m)
			}
		}
	}
	return out
}

/* ---------- compute ---------- */

// ruleImdsV1 is the highest-value compute check: with IMDSv1 reachable, any
// server-side request forgery in an application on the instance can read the
// instance role's credentials with a plain GET.
func ruleImdsV1(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("EC2") {
		endpoint, ok := propStr(n, "imds_endpoint")
		if ok && strings.EqualFold(endpoint, "disabled") {
			continue // metadata service off entirely; nothing to steal
		}
		tokens, known := propStr(n, "imds_tokens")
		if !known {
			continue
		}
		if !strings.EqualFold(tokens, "required") {
			out = append(out, nfEv(n, "ec2-imdsv1-enabled", "critical", "compute",
				fmt.Sprintf("%s allows IMDSv1 (HttpTokens=%s) — an SSRF on this host can read its role credentials", resourceDesc(n), tokens),
				"Set HttpTokens=required (IMDSv2) via ModifyInstanceMetadataOptions",
				map[string]any{"http_tokens": tokens}))
		}
		// A hop limit above 1 lets a container on the host reach the metadata
		// endpoint through the docker bridge.
		if hops, ok := propInt(n, "imds_hop_limit"); ok && hops > 1 {
			out = append(out, nfEv(n, "ec2-imds-hop-limit", "low", "compute",
				fmt.Sprintf("%s has an IMDS hop limit of %d, reachable from containers on the host", resourceDesc(n), hops),
				"Set HttpPutResponseHopLimit to 1 unless containers legitimately need instance credentials",
				map[string]any{"hop_limit": hops}))
		}
	}
	return out
}

// rulePublicInstance flags instances carrying a public IP. Not a defect by
// itself, but every one is attack surface that should be deliberate.
func rulePublicInstance(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("EC2") {
		ip, ok := propStr(n, "public_ip")
		if !ok || ip == "" {
			continue
		}
		if state, _ := propStr(n, "state"); state != "" && state != "running" {
			continue
		}
		out = append(out, nfEv(n, "ec2-public-ip", "medium", "network-exposure",
			fmt.Sprintf("%s is running with a public IP address", resourceDesc(n)),
			"Move the instance behind a load balancer or NAT gateway, and use SSM Session Manager instead of direct access",
			map[string]any{"public_ip": ip}))
	}
	return out
}

// secretishEnvName matches variable names that look like they hold a secret.
// Names referencing a secret rather than containing one (…_ARN, …_NAME, …_ID,
// …_URL) are the *correct* pattern and must not be flagged.
func secretishEnvName(name string) bool {
	u := strings.ToUpper(name)
	for _, suffix := range []string{"_ARN", "_NAME", "_ID", "_URL", "_URI", "_PATH", "_ENABLED"} {
		if strings.HasSuffix(u, suffix) {
			return false
		}
	}
	for _, needle := range []string{
		"SECRET", "PASSWORD", "PASSWD", "TOKEN", "APIKEY", "API_KEY",
		"ACCESS_KEY", "PRIVATE_KEY", "CREDENTIAL", "PASSPHRASE", "SESSION_KEY",
	} {
		if strings.Contains(u, needle) {
			return true
		}
	}
	return false
}

// ruleLambdaEnvSecret flags secret-shaped environment variables. Only the names
// are collected and reported — never the values.
func ruleLambdaEnvSecret(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("LAMBDA") {
		var hits []string
		for _, k := range propStrSlice(n, "env_var_names") {
			if secretishEnvName(k) {
				hits = append(hits, k)
			}
		}
		if len(hits) == 0 {
			continue
		}
		out = append(out, nfEv(n, "lambda-env-secret", "high", "secrets",
			fmt.Sprintf("%s has secret-shaped environment variables: %s", resourceDesc(n), strings.Join(hits, ", ")),
			"Move the value into Secrets Manager or SSM Parameter Store and reference it at runtime",
			map[string]any{"variables": hits}))
	}
	return out
}

// eolLambdaRuntimes are runtimes AWS no longer patches. This list needs periodic
// maintenance — AWS deprecates on a rolling schedule.
var eolLambdaRuntimes = map[string]bool{
	"nodejs":        true,
	"nodejs4.3":     true,
	"nodejs6.10":    true,
	"nodejs8.10":    true,
	"nodejs10.x":    true,
	"nodejs12.x":    true,
	"nodejs14.x":    true,
	"nodejs16.x":    true,
	"python2.7":     true,
	"python3.6":     true,
	"python3.7":     true,
	"python3.8":     true,
	"ruby2.5":       true,
	"ruby2.7":       true,
	"dotnetcore2.1": true,
	"dotnetcore3.1": true,
	"java8":         true,
	"go1.x":         true,
}

func ruleLambdaRuntime(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("LAMBDA") {
		rt, ok := propStr(n, "runtime")
		if !ok || !eolLambdaRuntimes[rt] {
			continue
		}
		out = append(out, nfEv(n, "lambda-eol-runtime", "high", "patching",
			fmt.Sprintf("%s runs on %s, which AWS no longer supports", resourceDesc(n), rt),
			"Upgrade the function to a supported runtime",
			map[string]any{"runtime": rt}))
	}
	return out
}

/* ---------- data protection ---------- */

func ruleS3Hardening(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("S3BUCKET") {
		// Block Public Access is the backstop that makes a policy mistake
		// harmless, so report it independently of whether the bucket is public.
		if !blockPublicAccessOn(n.Properties) {
			if _, known := propBool(n, "block_public_policy"); known {
				out = append(out, nf(n, "s3-bpa-off", "high", "data-exposure",
					fmt.Sprintf("%s does not have Block Public Access fully enabled", resourceDesc(n)),
					"Enable all four Block Public Access settings on the bucket (or account-wide)"))
			}
		}
		if enc, ok := propStr(n, "encryption"); !ok || enc == "" {
			out = append(out, nf(n, "s3-no-encryption", "medium", "encryption",
				fmt.Sprintf("%s has no default server-side encryption", resourceDesc(n)),
				"Enable default encryption (SSE-KMS preferred over SSE-S3)"))
		}
		if v, _ := propStr(n, "versioning"); !strings.EqualFold(v, "Enabled") {
			out = append(out, nf(n, "s3-no-versioning", "medium", "resilience",
				fmt.Sprintf("%s does not have versioning enabled", resourceDesc(n)),
				"Enable versioning so overwritten or ransomed objects can be recovered"))
		}
		if logging, known := propBool(n, "access_logging"); known && !logging {
			out = append(out, nf(n, "s3-no-access-logging", "low", "observability",
				fmt.Sprintf("%s has no server access logging", resourceDesc(n)),
				"Enable server access logging to a dedicated log bucket"))
		}
		if policy, _ := propStr(n, "bucket_policy"); !deniesInsecureTransport(policy) {
			out = append(out, nf(n, "s3-no-secure-transport", "medium", "encryption",
				fmt.Sprintf("%s does not deny non-TLS access", resourceDesc(n)),
				"Add a bucket policy statement denying requests where aws:SecureTransport is false"))
		}
	}
	return out
}

// deniesInsecureTransport reports whether the policy contains the standard
// Deny-on-aws:SecureTransport-false statement.
func deniesInsecureTransport(policy string) bool {
	if policy == "" {
		return false
	}
	return strings.Contains(policy, "aws:SecureTransport") && strings.Contains(policy, "Deny")
}

const minBackupRetentionDays = 7

func ruleRdsHardening(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("RDS") {
		if pub, ok := propBool(n, "publicly_accessible"); ok && pub {
			out = append(out, nf(n, "rds-publicly-accessible", "critical", "network-exposure",
				fmt.Sprintf("%s is publicly accessible from the internet", resourceDesc(n)),
				"Set PubliclyAccessible=false and reach the database through private subnets or a bastion/SSM"))
		}
		// A read replica has retention 0 because its source holds the backups.
		// Flagging it reports the design as a defect.
		isReplica, _ := propBool(n, "is_read_replica")
		if days, ok := propInt(n, "backup_retention_days"); ok && !isReplica {
			switch {
			case days == 0:
				out = append(out, nf(n, "rds-no-backup", "high", "resilience",
					fmt.Sprintf("%s has automated backups disabled", resourceDesc(n)),
					"Set a backup retention period of at least 7 days"))
			case days < minBackupRetentionDays:
				out = append(out, nfEv(n, "rds-no-backup", "medium", "resilience",
					fmt.Sprintf("%s retains backups for only %d day(s)", resourceDesc(n), days),
					fmt.Sprintf("Raise backup retention to at least %d days", minBackupRetentionDays),
					map[string]any{"retention_days": days}))
			}
		}
		if prot, ok := propBool(n, "deletion_protection"); ok && !prot {
			out = append(out, nf(n, "rds-no-deletion-protection", "medium", "resilience",
				fmt.Sprintf("%s does not have deletion protection enabled", resourceDesc(n)),
				"Enable deletion protection on production databases"))
		}
		if up, ok := propBool(n, "auto_minor_version_upgrade"); ok && !up {
			out = append(out, nf(n, "rds-no-minor-upgrade", "low", "patching",
				fmt.Sprintf("%s has automatic minor version upgrades disabled", resourceDesc(n)),
				"Enable auto minor version upgrade so engine security patches apply"))
		}
	}
	return out
}

func ruleEcrHardening(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("ECRREPOSITORY") {
		if scan, ok := propBool(n, "scan_on_push"); ok && !scan {
			out = append(out, nf(n, "ecr-scan-disabled", "medium", "patching",
				fmt.Sprintf("%s does not scan images on push", resourceDesc(n)),
				"Enable scan-on-push, or enable enhanced scanning via Inspector"))
		}
		if m, ok := propStr(n, "image_tag_mutability"); ok && strings.EqualFold(m, "MUTABLE") {
			out = append(out, nf(n, "ecr-mutable-tags", "low", "supply-chain",
				fmt.Sprintf("%s allows mutable image tags", resourceDesc(n)),
				"Set tag immutability so a reviewed tag cannot be replaced"))
		}
	}
	return out
}

/* ---------- network ---------- */

// ruleEksPublicEndpoint flags a Kubernetes API server reachable from the
// internet. Public access restricted to specific CIDRs is materially different
// from 0.0.0.0/0, so they are graded differently.
func ruleEksPublicEndpoint(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("EKSCLUSTER") {
		pub, ok := propBool(n, "endpoint_public_access")
		if !ok || !pub {
			continue
		}
		cidrs := propStrSlice(n, "public_access_cidrs")
		openToAll := len(cidrs) == 0
		for _, c := range cidrs {
			if c == "0.0.0.0/0" {
				openToAll = true
			}
		}
		sev, detail := "high", "public endpoint restricted to "+strings.Join(cidrs, ", ")
		if openToAll {
			sev, detail = "critical", "public endpoint open to 0.0.0.0/0"
		}
		out = append(out, nfEv(n, "eks-public-endpoint", sev, "network-exposure",
			fmt.Sprintf("%s API server has a %s", resourceDesc(n), detail),
			"Disable public endpoint access, or restrict it to known CIDRs and enable private access",
			map[string]any{"public_access_cidrs": cidrs}))
	}
	return out
}

// ruleSgOpenEgress flags fully unrestricted egress. Low on its own, but it is
// what turns a foothold into data exfiltration and C2.
func ruleSgOpenEgress(g *Graph) []Finding {
	var out []Finding
	for _, n := range g.NodesWithLabel("SG") {
		rules, ok := n.Properties["egress_rules"].([]any)
		if !ok {
			continue
		}
		for _, r := range rules {
			m, _ := r.(map[string]any)
			cidr, _ := m["cidr"].(string)
			if cidr != "0.0.0.0/0" && cidr != "::/0" {
				continue
			}
			proto, _ := m["protocol"].(string)
			if proto != "-1" {
				continue
			}
			out = append(out, nf(n, "sg-open-egress-all", "low", "network-exposure",
				fmt.Sprintf("%s allows unrestricted outbound traffic to %s", resourceDesc(n), cidr),
				"Restrict egress to the destinations the workload actually needs"))
			break
		}
	}
	return out
}
