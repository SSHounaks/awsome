package awscfg

import (
	"context"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
)

func Load(ctx context.Context, endpointURL, region, profile string) (aws.Config, error) {
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(region)}
	if profile == "" {
		profile = os.Getenv("AWS_PROFILE")
	}
	if profile != "" {
		opts = append(opts, awsconfig.WithSharedConfigProfile(profile))
	}
	if endpointURL == "" {
		endpointURL = os.Getenv("AWS_ENDPOINT_URL")
	}
	c, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return aws.Config{}, err
	}
	if endpointURL != "" {
		c.BaseEndpoint = aws.String(endpointURL)
	}
	return c, nil
}
