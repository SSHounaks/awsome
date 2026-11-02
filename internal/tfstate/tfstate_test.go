package tfstate

import (
	"encoding/json"
	"strings"
	"testing"
)

const sample = `{
  "version": 4,
  "terraform_version": "1.9.6",
  "serial": 646,
  "resources": [
    {
      "mode": "managed", "type": "aws_instance", "name": "jump",
      "instances": [{"attributes": {
        "id": "i-0abc", "arn": "arn:aws-us-gov:ec2:us-gov-west-1:111111111111:instance/i-0abc",
        "password": "hunter2", "user_data": "export DB_PASS=s3cr3t"
      }}]
    },
    {
      "mode": "managed", "type": "aws_ssm_parameter", "name": "conn",
      "module": "module.ssm",
      "instances": [{"index_key": "prod", "attributes": {
        "id": "/Config/SEQUELIZE_CONN_STRING", "arn": "arn:aws-us-gov:ssm:us-gov-west-1:111111111111:parameter/Config/X",
        "value": "mysql://user:password@host/db", "type": "SecureString"
      }}]
    },
    {
      "mode": "data", "type": "aws_caller_identity", "name": "current",
      "instances": [{"attributes": {"account_id": "111111111111"}}]
    },
    {
      "mode": "managed", "type": "aws_lb_target_group", "name": "api",
      "instances": [{"index_key": 0, "attributes": {"id": "tg-1", "arn": "arn:aws-us-gov:elasticloadbalancing:...:targetgroup/api"}}]
    }
  ]
}`

func TestParseKeepsOnlyIdentity(t *testing.T) {
	decls, meta, err := Parse(strings.NewReader(sample), "111111111111", "snap-1", "t0")
	if err != nil {
		t.Fatal(err)
	}

	// The data block declares nothing.
	if meta.Managed != 3 || len(decls) != 3 {
		t.Fatalf("managed=%d declared=%d, want 3 and 3 (data blocks excluded)", meta.Managed, len(decls))
	}

	// The critical property: no secret from the state can appear anywhere in a
	// serialised declaration.
	blob, err := json.Marshal(decls)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"hunter2", "s3cr3t", "mysql://", "password@host", "SecureString"} {
		if strings.Contains(string(blob), secret) {
			t.Errorf("serialised declarations leaked %q from terraform state", secret)
		}
	}
}

func TestParseExtractsMatchKeys(t *testing.T) {
	decls, _, err := Parse(strings.NewReader(sample), "111111111111", "snap-1", "t0")
	if err != nil {
		t.Fatal(err)
	}
	byType := map[string]Declared{}
	for _, d := range decls {
		byType[d.Type] = d
	}

	ec2 := byType["aws_instance"]
	if ec2.ARN == "" || ec2.ResourceID != "i-0abc" {
		t.Errorf("aws_instance identity = %+v, want arn and id populated", ec2)
	}
	if ec2.Address != "aws_instance.jump" {
		t.Errorf("address = %q, want aws_instance.jump", ec2.Address)
	}
}

func TestAddressIncludesModuleAndIndex(t *testing.T) {
	decls, _, err := Parse(strings.NewReader(sample), "1", "s", "t")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, d := range decls {
		got[d.Address] = true
	}
	// A finding has to name the exact block to edit, including module path and
	// for_each / count key.
	for _, want := range []string{`module.ssm.aws_ssm_parameter.conn["prod"]`, "aws_lb_target_group.api[0]"} {
		if !got[want] {
			t.Errorf("missing address %q; got %v", want, got)
		}
	}
}

func TestParseRejectsUnknownStateVersion(t *testing.T) {
	// A wrong-version read would look like every resource drifted at once.
	_, _, err := Parse(strings.NewReader(`{"version":3,"resources":[]}`), "1", "s", "t")
	if err == nil {
		t.Error("expected state version 3 to be rejected")
	}
}
