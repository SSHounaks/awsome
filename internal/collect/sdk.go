package collect

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"

	"awsome/internal/awscfg"
)

func sdkConfig(ctx context.Context, cfg Config, region string) (aws.Config, error) {
	return awscfg.Load(ctx, cfg.EndpointURL, region, cfg.Profile)
}
