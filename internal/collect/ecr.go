package collect

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	"github.com/aws/aws-sdk-go-v2/service/ecr/types"
)

func collectEcrRepositories(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := ecr.NewFromConfig(sdk)
	paginator := ecr.NewDescribeRepositoriesPaginator(client, &ecr.DescribeRepositoriesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s DescribeRepositories: %w", a.region, err)
		}
		for _, r := range page.Repositories {
			emitRepository(a, r, emit)
		}
	}
	return nil
}

func emitRepository(a acc, r types.Repository, emit *Emitter) {
	n := a.now()
	n.Label = "ECRREPOSITORY"
	n.Key = aws.ToString(r.RepositoryArn)
	n.Properties = map[string]any{
		"repository_uri":       aws.ToString(r.RepositoryUri),
		"image_tag_mutability": string(r.ImageTagMutability),
		"repo_name":            aws.ToString(r.RepositoryName),
	}
	if r.EncryptionConfiguration != nil {
		n.Properties["encryption_type"] = string(r.EncryptionConfiguration.EncryptionType)
	}
	if r.CreatedAt != nil {
		n.Properties["created"] = r.CreatedAt.String()
	}
	emit.Send(n)
}
