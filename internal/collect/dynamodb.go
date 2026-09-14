package collect

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func collectTables(ctx context.Context, cfg Config, a acc, emit *Emitter) error {
	sdk, err := sdkConfig(ctx, cfg, a.region)
	if err != nil {
		return err
	}
	client := dynamodb.NewFromConfig(sdk)
	paginator := dynamodb.NewListTablesPaginator(client, &dynamodb.ListTablesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("%s ListTables: %w", a.region, err)
		}
		for _, name := range page.TableNames {
			out, err := client.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: aws.String(name)})
			if err != nil {
				return fmt.Errorf("%s DescribeTable: %w", a.region, err)
			}
			tags := map[string]string{}
			if out.Table.TableArn != nil {
				res, err := client.ListTagsOfResource(ctx, &dynamodb.ListTagsOfResourceInput{ResourceArn: out.Table.TableArn})
				if err == nil {
					for _, tag := range res.Tags {
						tags[aws.ToString(tag.Key)] = aws.ToString(tag.Value)
					}
				}
			}
			emitTable(a, out.Table, tags, emit)
		}
	}
	return nil
}

func emitTable(a acc, t *types.TableDescription, tags map[string]string, emit *Emitter) {
	n := a.now()
	n.Label = "DYNAMODBTABLE"
	n.Key = fmt.Sprintf("arn:%s:dynamodb:%s:%s:table/%s", a.partition, a.region, a.accountID, aws.ToString(t.TableName))
	if len(tags) > 0 {
		n.Tags = tags
	}
	n.Name = tagValue(tags, "Name")
	n.Properties = map[string]any{
		"status":          string(t.TableStatus),
		"key_schema":      len(t.KeySchema),
		"attribute_count": len(t.AttributeDefinitions),
	}
	if t.BillingModeSummary != nil {
		n.Properties["billing_mode"] = string(t.BillingModeSummary.BillingMode)
	}
	if t.ItemCount != nil {
		n.Properties["item_count"] = *t.ItemCount
	}
	if t.CreationDateTime != nil {
		n.Properties["creation_date"] = t.CreationDateTime.UTC().Format(time.RFC3339)
	}
	emit.Send(n)
}
