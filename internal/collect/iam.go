package collect

import (
	"context"
	"fmt"
	"net/url"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/iam/types"
)

func collectIam(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := iam.NewFromConfig(sdk)

	roles := iam.NewListRolesPaginator(client, &iam.ListRolesInput{})
	for roles.HasMorePages() {
		page, err := roles.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListRoles: %w", a.region, err)
		}
		for _, role := range page.Roles {
			attached, err := client.ListAttachedRolePolicies(ctx, &iam.ListAttachedRolePoliciesInput{RoleName: role.RoleName})
			if err != nil {
				return fmt.Errorf("%s ListAttachedRolePolicies: %w", a.region, err)
			}
			emitIamRole(a, role, attached.AttachedPolicies, emit)
		}
	}

	policies := iam.NewListPoliciesPaginator(client, &iam.ListPoliciesInput{Scope: "Local"})
	for policies.HasMorePages() {
		page, err := policies.NextPage(ctx)
		if err != nil {
			break
		}
		for _, policy := range page.Policies {
			document := ""
			if policy.DefaultVersionId == nil {
				emitIamPolicy(a, policy, document, emit)
				continue
			}
			if _, err := client.ListPolicyVersions(ctx, &iam.ListPolicyVersionsInput{PolicyArn: policy.Arn}); err != nil {
				continue
			}
			pv, err := client.GetPolicyVersion(ctx, &iam.GetPolicyVersionInput{PolicyArn: policy.Arn, VersionId: policy.DefaultVersionId})
			if err != nil {
				continue
			}
			if pv.PolicyVersion != nil {
				if doc, uerr := url.QueryUnescape(aws.ToString(pv.PolicyVersion.Document)); uerr == nil {
					document = doc
				}
			}
			emitIamPolicy(a, policy, document, emit)
		}
	}

	profiles := iam.NewListInstanceProfilesPaginator(client, &iam.ListInstanceProfilesInput{})
	for profiles.HasMorePages() {
		page, err := profiles.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListInstanceProfiles: %w", a.region, err)
		}
		for _, p := range page.InstanceProfiles {
			emitIamProfile(a, p, emit)
		}
	}
	return nil
}

func emitIamRole(a acc, role types.Role, attached []types.AttachedPolicy, emit *Emitter) {
	key := aws.ToString(role.Arn)
	n := a.now()
	n.Label = "IAMROLE"
	n.Key = key
	trustPolicy, _ := url.QueryUnescape(aws.ToString(role.AssumeRolePolicyDocument))
	n.Properties = map[string]any{
		"role_name":    aws.ToString(role.RoleName),
		"path":         aws.ToString(role.Path),
		"description":  aws.ToString(role.Description),
		"trust_policy": trustPolicy,
	}
	if role.CreateDate != nil {
		n.Properties["created"] = role.CreateDate.String()
	}
	emit.Send(n)

	for _, ap := range attached {
		if pArn := aws.ToString(ap.PolicyArn); pArn != "" {
			emit.Send(a.edge(n.Key, pArn, "USES_POLICY"))
		}
	}
}

func emitIamPolicy(a acc, policy types.Policy, document string, emit *Emitter) {
	n := a.now()
	n.Label = "IAMPOLICY"
	n.Key = aws.ToString(policy.Arn)
	n.Properties = map[string]any{
		"policy_name":     aws.ToString(policy.PolicyName),
		"path":            aws.ToString(policy.Path),
		"description":     aws.ToString(policy.Description),
		"default_version": aws.ToString(policy.DefaultVersionId),
	}
	if document != "" {
		n.Properties["document"] = document
	}
	emit.Send(n)
}

func emitIamProfile(a acc, p types.InstanceProfile, emit *Emitter) {
	n := a.now()
	n.Label = "IAMPROFILE"
	n.Key = aws.ToString(p.Arn)
	n.Properties = map[string]any{
		"profile_name": aws.ToString(p.InstanceProfileName),
		"path":         aws.ToString(p.Path),
	}
	if p.CreateDate != nil {
		n.Properties["created"] = p.CreateDate.String()
	}
	emit.Send(n)

	for _, role := range p.Roles {
		if rn := aws.ToString(role.RoleName); rn != "" {
			emit.Send(a.edge(n.Key, fmt.Sprintf("arn:%s:iam::%s:role/%s", a.partition, a.accountID, rn), "HAS_ROLE"))
		}
	}
}
