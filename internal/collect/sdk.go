package collect

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"

	"awsome/internal/awscfg"
)

// sdkConfig takes the profile explicitly rather than reading it off Config,
// because a single scan can span several accounts and each one authenticates
// with its own profile.
func sdkConfig(ctx context.Context, cfg Config, region, profile string) (aws.Config, error) {
	return awscfg.Load(ctx, cfg.EndpointURL, region, profile)
}

// sdk builds the client config for the account this step belongs to.
func (a acc) sdk(ctx context.Context, cfg Config) (aws.Config, error) {
	return sdkConfig(ctx, cfg, a.region, a.profile)
}
