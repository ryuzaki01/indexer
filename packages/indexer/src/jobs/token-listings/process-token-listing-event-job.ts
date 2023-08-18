import { logger } from "@/common/logger";

import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";

import * as tokenListingsIndex from "@/elasticsearch/indexes/token-listings";
import { TokenListingBuilder } from "@/elasticsearch/indexes/token-listings/base";
import { Orders } from "@/utils/orders";
import { idb } from "@/common/db";
import { fromBuffer, toBuffer } from "@/common/utils";

export enum EventKind {
  newSellOrder = "newSellOrder",
}

export type ProcessTokenListingEventJobPayload = {
  kind: EventKind.newSellOrder;
  data: OrderInfo;
  context?: string;
};

export class ProcessTokenListingEventJob extends AbstractRabbitMqJobHandler {
  queueName = "process-token-listing-event-queue";
  maxRetries = 10;
  concurrency = 15;
  persistent = true;
  lazyMode = true;

  protected async process(payload: ProcessTokenListingEventJobPayload) {
    const { kind, data } = payload;

    logger.info(
      this.queueName,
      JSON.stringify({
        message: `Start. kind=${kind}`,
        kind,
        data,
      })
    );

    let tokenListing;

    try {
      const criteriaBuildQuery = Orders.buildCriteriaQuery("orders", "token_set_id", true);

      const rawResult = await idb.oneOrNone(
        `
            SELECT           
              (${criteriaBuildQuery}) AS order_criteria,
              nb.*,
              t.*
            FROM orders
            JOIN LATERAL (
                    SELECT
                        nft_balances.owner AS "ownership_owner",
                        nft_balances.amount AS "ownership_amount",
                        nft_balances.acquired_at AS "ownership_acquired_at"
                    FROM nft_balances
                    WHERE orders.maker = nft_balances.owner
                    AND decode(substring(split_part(orders.token_set_id, ':', 2) from 3), 'hex') = nft_balances.contract
                    AND (split_part(orders.token_set_id, ':', 3)::NUMERIC(78, 0)) = nft_balances.token_id
                    LIMIT 1
                 ) nb ON TRUE
            JOIN LATERAL (
                    SELECT
                        tokens.token_id,
                        tokens.name AS "token_name",
                        tokens.image AS "token_image",
                        tokens.media AS "token_media",
                        collections.id AS "collection_id",
                        collections.name AS "collection_name",
                        (collections.metadata ->> 'imageUrl')::TEXT AS "collection_image"
                    FROM tokens
                    JOIN collections on collections.id = tokens.collection_id
                    WHERE decode(substring(split_part(orders.token_set_id, ':', 2) from 3), 'hex') = tokens.contract
                    AND (split_part(orders.token_set_id, ':', 3)::NUMERIC(78, 0)) = tokens.token_id
                    LIMIT 1
                 ) t ON TRUE
            WHERE orders.id = $/orderId/
          `,
        { orderId: data.id }
      );

      if (rawResult) {
        const id = `${fromBuffer(rawResult.ownership_owner)}:${data.contract}:${
          rawResult.token_id
        }:${data.id}`;

        logger.info(
          this.queueName,
          JSON.stringify({
            message: `Debug. kind=${kind}, id=${id}`,
            kind,
            data,
          })
        );

        tokenListing = new TokenListingBuilder().buildDocument({
          id,
          timestamp: Math.floor(new Date(data.created_at).getTime() / 1000),
          contract: toBuffer(data.contract),
          ownership_address: rawResult.ownership_owner,
          ownership_amount: rawResult.ownership_amount,
          ownership_acquired_at: new Date(rawResult.ownership_acquired_at),
          token_id: rawResult.token_id,
          token_name: rawResult.token_name,
          token_image: rawResult.token_image,
          token_media: rawResult.token_media,
          collection_id: rawResult.collection_id,
          collection_name: rawResult.collection_name,
          collection_image: rawResult.collection_image,
          order_id: data.id,
          order_source_id_int: data.source_id_int,
          order_criteria: rawResult.order_criteria,
          order_quantity: data.quantity_filled + data.quantity_remaining,
          order_pricing_currency: toBuffer(data.currency),
          order_pricing_fee_bps: data.fee_bps,
          order_pricing_price: data.price,
          order_pricing_currency_price: data.currency_price,
          order_pricing_value: data.value,
          order_pricing_currency_value: data.currency_value,
          order_pricing_normalized_value: data.normalized_value,
          order_pricing_currency_normalized_value: data.currency_normalized_value,
        });
      }
    } catch (error) {
      logger.error(
        this.queueName,
        JSON.stringify({
          message: `Error generating token listing. kind=${kind}, error=${error}`,
          error,
          data,
        })
      );

      throw error;
    }

    if (tokenListing) {
      await tokenListingsIndex.save([tokenListing]);
    }
  }

  public async addToQueue(payloads: ProcessTokenListingEventJobPayload[]) {
    await this.sendBatch(payloads.map((payload) => ({ payload })));
  }
}

export const processTokenListingEventJob = new ProcessTokenListingEventJob();

interface OrderInfo {
  id: string;
  side: string;
  contract: string;
  currency: string;
  price: string;
  value: string;
  currency_price: string;
  currency_value: string;
  normalized_value: string;
  currency_normalized_value: string;
  source_id_int: number;
  quantity_filled: number;
  quantity_remaining: number;
  fee_bps: number;
  fillability_status: string;
  approval_status: string;
  created_at: string;
}
