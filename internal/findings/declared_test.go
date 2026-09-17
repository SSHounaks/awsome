package findings

import (
	"testing"

	"awsome/internal/model"
)

func TestNodeSuffixKeepsIdsContainingSlash(t *testing.T) {
	cases := map[string]string{
		// resource-type/id
		"arn:aws-us-gov:ec2:us-gov-west-1:1:instance/i-0abc": "i-0abc",
		// ECR repository names legitimately contain "/", and splitting on the
		// last one truncated them to the final segment.
		"arn:aws-us-gov:ecr:us-gov-west-1:1:repository/icf/api":            "icf/api",
		"arn:aws-us-gov:ecr:us-gov-west-1:1:repository/ffmpeg/patch-2022":  "ffmpeg/patch-2022",
		"arn:aws-us-gov:dynamodb:us-gov-west-1:1:table/events":             "events",
		"arn:aws-us-gov:elasticache:us-gov-west-1:1:cluster:redis-api-002": "redis-api-002",
		"arn:aws-us-gov:s3:::bucket-name":                                  "bucket-name",
		"not-an-arn":                                                       "not-an-arn",
	}
	for in, want := range cases {
		if got := nodeSuffix(in); got != want {
			t.Errorf("nodeSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLookupMatchesDerivedElastiCacheNodes(t *testing.T) {
	idx := &DeclarationIndex{
		byARN: map[string]Declaration{},
		byID: map[string]Declaration{
			// Terraform declares the replication group...
			"redis-api": {Address: "aws_elasticache_replication_group.api", AccountID: "1"},
		},
		count: 1,
	}

	// ...AWS materialises cluster nodes with a -00N suffix. Without derivation
	// every node in every replication group reads as unmanaged.
	if _, ok := idx.Lookup("ELASTICACHE", "arn:aws-us-gov:elasticache:r:1:cluster:redis-api-002", ""); !ok {
		t.Error("cluster node redis-api-002 should match replication group redis-api")
	}
	// The derivation must not fire for other labels, or it would match unrelated
	// resources whose names happen to end in three digits.
	if _, ok := idx.Lookup("EC2", "arn:aws-us-gov:ec2:r:1:instance/redis-api-002", ""); ok {
		t.Error("the -00N derivation must be scoped to ElastiCache")
	}
}

func TestLookupMatchesByArnAndId(t *testing.T) {
	idx := &DeclarationIndex{
		byARN: map[string]Declaration{"arn:aws:s3:::logs": {Address: "aws_s3_bucket.logs"}},
		byID:  map[string]Declaration{"i-0abc": {Address: "aws_instance.jump"}},
		count: 2,
	}
	if _, ok := idx.Lookup("S3BUCKET", "arn:aws:s3:::logs", "logs"); !ok {
		t.Error("exact ARN should match")
	}
	if _, ok := idx.Lookup("EC2", "arn:aws:ec2:r:1:instance/i-0abc", ""); !ok {
		t.Error("id embedded in the ARN should match")
	}
	if _, ok := idx.Lookup("EC2", "arn:aws:ec2:r:1:instance/i-9zzz", ""); ok {
		t.Error("an unrelated instance must not match")
	}
}

func TestUnmanagedRuleOnlyJudgesIngestedAccounts(t *testing.T) {
	idx := &DeclarationIndex{
		byID:  map[string]Declaration{"i-known": {AccountID: "111111111111"}},
		byARN: map[string]Declaration{},
		count: 1,
	}
	g := graphOf(
		// same account as the ingested state, not declared -> flagged
		model.Node{Label: "EC2", Key: "arn:aws:ec2:r:111111111111:instance/i-rogue", Name: "rogue", AccountID: "111111111111"},
		// same account, declared -> quiet
		model.Node{Label: "EC2", Key: "arn:aws:ec2:r:111111111111:instance/i-known", Name: "known", AccountID: "111111111111"},
		// an account whose state was never read must not be judged at all,
		// otherwise everything it owns looks unmanaged
		model.Node{Label: "EC2", Key: "arn:aws:ec2:r:999999999999:instance/i-other", Name: "other", AccountID: "999999999999"},
		// labels outside the allowlist are not evaluated
		model.Node{Label: "ENI", Key: "arn:aws:ec2:r:111111111111:network-interface/eni-1", AccountID: "111111111111"},
	)
	g.Declarations = idx

	out := ruleUnmanagedResource(g)
	if len(out) != 1 || out[0].ResourceName != "rogue" {
		t.Fatalf("expected only the undeclared in-scope instance, got %+v", out)
	}
}

func TestUnmanagedRuleSilentWithoutDeclarations(t *testing.T) {
	g := graphOf(model.Node{Label: "EC2", Key: "arn:aws:ec2:r:1:instance/i-1", AccountID: "111111111111"})
	if out := ruleUnmanagedResource(g); len(out) != 0 {
		t.Errorf("without ingested state the rule must stay quiet, got %d", len(out))
	}
}
