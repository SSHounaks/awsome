package collect

import (
	"context"
	"fmt"
	"net/url"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func collectBuckets(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := s3.NewFromConfig(sdk, func(o *s3.Options) { o.UsePathStyle = true })
	out, err := client.ListBuckets(ctx, &s3.ListBucketsInput{})
	if err != nil {
		return fmt.Errorf("%s ListBuckets: %w", a.region, err)
	}
	for _, b := range out.Buckets {
		name := aws.ToString(b.Name)
		if name == "" {
			continue
		}
		loc, err := client.GetBucketLocation(ctx, &s3.GetBucketLocationInput{Bucket: aws.String(name)})
		if err != nil {
			return fmt.Errorf("%s GetBucketLocation: %w", a.region, err)
		}
		region := string(loc.LocationConstraint)
		if region == "" {
			region = "us-east-1"
		}
		if region != a.region {
			continue
		}

		var grants []map[string]any
		if acl, err := client.GetBucketAcl(ctx, &s3.GetBucketAclInput{Bucket: aws.String(name)}); err == nil {
			for _, g := range acl.Grants {
				if g.Grantee == nil {
					continue
				}
				m := map[string]any{}
				if v := string(g.Permission); v != "" {
					m["permission"] = v
				}
				if v := string(g.Grantee.Type); v != "" {
					m["grantee_type"] = v
				}
				if v := aws.ToString(g.Grantee.URI); v != "" {
					m["grantee_uri"] = v
				}
				if v := aws.ToString(g.Grantee.ID); v != "" {
					m["grantee_id"] = v
				}
				grants = append(grants, m)
			}
		}

		policy := ""
		if p, err := client.GetBucketPolicy(ctx, &s3.GetBucketPolicyInput{Bucket: aws.String(name)}); err == nil {
			if decoded, uerr := url.QueryUnescape(aws.ToString(p.Policy)); uerr == nil {
				policy = decoded
			}
		}

		var tags map[string]string
		if tagOut, err := client.GetBucketTagging(ctx, &s3.GetBucketTaggingInput{Bucket: aws.String(name)}); err == nil {
			tags = make(map[string]string, len(tagOut.TagSet))
			for _, t := range tagOut.TagSet {
				tags[aws.ToString(t.Key)] = aws.ToString(t.Value)
			}
		}

		versioning := ""
		if v, err := client.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(name)}); err == nil {
			versioning = string(v.Status)
		}

		emitBucket(a, name, region, grants, policy, tags, versioning, emit)
	}
	return nil
}

func emitBucket(a acc, name, region string, grants []map[string]any, policy string, tags map[string]string, versioning string, emit *Emitter) {
	n := a.now()
	n.Label = "S3BUCKET"
	n.Key = fmt.Sprintf("arn:%s:s3:::%s", a.partition, name)
	n.Tags = tags
	n.Name = tagValue(tags, "Name")
	n.Properties = map[string]any{
		"region": region,
	}
	if len(grants) > 0 {
		n.Properties["acl_grantees"] = grants
	}
	if policy != "" {
		n.Properties["bucket_policy"] = policy
	}
	if versioning != "" {
		n.Properties["versioning"] = versioning
	}
	emit.Send(n)
}
