package collect

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/iam/types"
)

// collectIamCredentials gathers the human/static-credential side of IAM: users,
// their access keys, MFA state, and the account password policy. This is a
// separate step from collectIam (roles/policies/profiles) because it is the part
// most likely to be denied by a restricted role, and degrading it should not cost
// us the role graph.
func collectIamCredentials(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := iam.NewFromConfig(sdk)

	if err := collectAccountPosture(ctx, client, a, emit); err != nil {
		return err
	}

	users := iam.NewListUsersPaginator(client, &iam.ListUsersInput{})
	for users.HasMorePages() {
		page, err := users.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("ListUsers: %w", err)
		}
		for _, u := range page.Users {
			emitIamUser(ctx, client, a, u, emit)
		}
	}
	return nil
}

// emitIamUser records one user plus the credential facts the rules need. Per-user
// lookups are best-effort: a denied sub-call should narrow the finding set, not
// abort the whole walker.
func emitIamUser(ctx context.Context, client *iam.Client, a acc, u types.User, emit *Emitter) {
	name := aws.ToString(u.UserName)
	n := a.now()
	n.Label = "IAMUSER"
	n.Key = aws.ToString(u.Arn)
	n.Name = name
	n.Properties = map[string]any{
		"user_name": name,
		"path":      aws.ToString(u.Path),
	}
	if u.CreateDate != nil {
		n.Properties["created"] = u.CreateDate.UTC().Format(time.RFC3339)
		n.Properties["age_days"] = daysSince(*u.CreateDate)
	}
	// PasswordLastUsed is only set when the user has console access and has used it.
	if u.PasswordLastUsed != nil {
		n.Properties["password_last_used_days"] = daysSince(*u.PasswordLastUsed)
	}

	// A login profile existing is what "console access" means; NoSuchEntity is the
	// normal answer for a programmatic-only user.
	if _, err := client.GetLoginProfile(ctx, &iam.GetLoginProfileInput{UserName: u.UserName}); err == nil {
		n.Properties["console_access"] = true
	} else if isNoSuchEntity(err) {
		n.Properties["console_access"] = false
	}

	if mfa, err := client.ListMFADevices(ctx, &iam.ListMFADevicesInput{UserName: u.UserName}); err == nil {
		n.Properties["mfa_devices"] = len(mfa.MFADevices)
		n.Properties["mfa_enabled"] = len(mfa.MFADevices) > 0
	}

	if keys, err := client.ListAccessKeys(ctx, &iam.ListAccessKeysInput{UserName: u.UserName}); err == nil {
		var active int
		var oldest, staleUnused int
		for _, k := range keys.AccessKeyMetadata {
			if k.Status != types.StatusTypeActive {
				continue
			}
			active++
			age := 0
			if k.CreateDate != nil {
				age = daysSince(*k.CreateDate)
			}
			if age > oldest {
				oldest = age
			}
			// LastUsedDate is nil when the key has never been used at all, which
			// for an old key is worse than merely idle.
			used, err := client.GetAccessKeyLastUsed(ctx, &iam.GetAccessKeyLastUsedInput{AccessKeyId: k.AccessKeyId})
			idle := age
			if err == nil && used.AccessKeyLastUsed != nil && used.AccessKeyLastUsed.LastUsedDate != nil {
				idle = daysSince(*used.AccessKeyLastUsed.LastUsedDate)
			}
			if idle > staleUnused {
				staleUnused = idle
			}
		}
		n.Properties["active_access_keys"] = active
		n.Properties["oldest_access_key_days"] = oldest
		n.Properties["most_idle_access_key_days"] = staleUnused
	}

	emit.Send(n)
}

// collectAccountPosture emits a single ACCOUNT node carrying the password policy
// and the root-account facts from GetAccountSummary.
func collectAccountPosture(ctx context.Context, client *iam.Client, a acc, emit *Emitter) error {
	n := a.now()
	n.Label = "ACCOUNT"
	n.Key = fmt.Sprintf("arn:%s:iam::%s:root", a.partition, a.accountID)
	n.Name = a.accountID
	n.Properties = map[string]any{"account_id": a.accountID}

	if sum, err := client.GetAccountSummary(ctx, &iam.GetAccountSummaryInput{}); err == nil {
		m := sum.SummaryMap
		// 1 = the root account has an access key / has MFA enabled.
		n.Properties["root_access_keys"] = int(m["AccountAccessKeysPresent"])
		n.Properties["root_mfa_enabled"] = m["AccountMFAEnabled"] == 1
		n.Properties["users"] = int(m["Users"])
		n.Properties["mfa_devices"] = int(m["MFADevices"])
	}

	if pol, err := client.GetAccountPasswordPolicy(ctx, &iam.GetAccountPasswordPolicyInput{}); err == nil && pol.PasswordPolicy != nil {
		p := pol.PasswordPolicy
		n.Properties["password_policy"] = true
		if p.MinimumPasswordLength != nil {
			n.Properties["password_min_length"] = int(*p.MinimumPasswordLength)
		}
		if p.PasswordReusePrevention != nil {
			n.Properties["password_reuse_prevention"] = int(*p.PasswordReusePrevention)
		}
		if p.MaxPasswordAge != nil {
			n.Properties["password_max_age_days"] = int(*p.MaxPasswordAge)
		}
		n.Properties["password_require_symbols"] = p.RequireSymbols
		n.Properties["password_require_numbers"] = p.RequireNumbers
		n.Properties["password_require_uppercase"] = p.RequireUppercaseCharacters
		n.Properties["password_require_lowercase"] = p.RequireLowercaseCharacters
	} else if isNoSuchEntity(err) {
		// No policy at all is itself the finding.
		n.Properties["password_policy"] = false
	}

	emit.Send(n)
	return nil
}

func daysSince(t time.Time) int {
	d := time.Since(t.UTC()).Hours() / 24
	if d < 0 {
		return 0
	}
	return int(d)
}

func isNoSuchEntity(err error) bool {
	return err != nil && strings.Contains(err.Error(), "NoSuchEntity")
}
