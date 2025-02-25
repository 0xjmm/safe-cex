import createHmac from 'create-hmac';
import { sumBy } from 'lodash';

import type { Position } from '../../types';
import { PositionSide } from '../../types';
import { roundUSD } from '../../utils/round-usd';
import { multiply, subtract } from '../../utils/safe-math';
import { virtualClock } from '../../utils/virtual-clock';
import { BaseWebSocket } from '../base.ws';

import type { OKXExchange } from './okx.exchange';
import { BASE_WS_URL } from './okx.types';

export class OKXPrivateWebsocket extends BaseWebSocket<OKXExchange> {
  connectAndSubscribe = () => {
    if (!this.isDisposed) {
      this.ws = new WebSocket(
        BASE_WS_URL.private[this.parent.options.testnet ? 'testnet' : 'livenet']
      );

      this.ws.addEventListener('open', this.onOpen);
      this.ws.addEventListener('message', this.onMessage);
      this.ws.addEventListener('close', this.onClose);
    }
  };

  onOpen = () => {
    if (!this.isDisposed) {
      this.auth();
      this.ping();
    }
  };

  ping = () => {
    if (!this.isDisposed) {
      this.pingAt = performance.now();
      this.ws?.send?.('ping');
    }
  };

  auth = () => {
    const timestamp = virtualClock.getCurrentTime().unix();
    const signature = createHmac('sha256', this.parent.options.secret)
      .update([timestamp, 'GET', '/users/self/verify'].join(''))
      .digest('base64');

    this.ws?.send?.(
      JSON.stringify({
        op: 'login',
        args: [
          {
            apiKey: this.parent.options.key,
            passphrase: this.parent.options.passphrase,
            timestamp,
            sign: signature,
          },
        ],
      })
    );
  };

  subscribe = () => {
    this.ws?.send?.(
      JSON.stringify({
        op: 'subscribe',
        args: [
          { channel: 'account' },
          { channel: 'positions', instType: 'SWAP' },
          { channel: 'orders', instType: 'SWAP' },
          { channel: 'orders-algo', instType: 'SWAP' },
          { channel: 'algo-advance', instType: 'SWAP' },
        ],
      })
    );
  };

  onMessage = ({ data }: MessageEvent) => {
    if (data.includes('event":"subscribe"')) {
      return;
    }

    if (data === 'pong') {
      this.handlePongEvent();
      return;
    }

    if (data === '{"event":"login", "msg" : "", "code": "0"}') {
      this.subscribe();
      return;
    }

    if (
      data.includes('"channel":"orders"') ||
      data.includes('"channel":"orders-algo"') ||
      data.includes('"channel":"algo-advance"')
    ) {
      this.handleOrderTopic(JSON.parse(data));
      return;
    }

    if (data.includes('"channel":"positions"')) {
      this.handlePositionTopic(JSON.parse(data));
      return;
    }

    if (data.includes('"channel":"account"')) {
      this.handleAccountTopic(JSON.parse(data));
    }
  };

  handlePongEvent = () => {
    const diff = performance.now() - this.pingAt;
    this.store.update({ latency: Math.round(diff / 2) });

    if (this.pingTimeoutId) {
      clearTimeout(this.pingTimeoutId);
      this.pingTimeoutId = undefined;
    }

    this.pingTimeoutId = setTimeout(() => this.ping(), 10_000);
  };

  handleOrderTopic = ({ data: okxOrders }: Record<string, any>) => {
    for (const o of okxOrders) {
      const orders = this.parent.mapOrders([o]);

      if (orders.length) {
        if (o.state === 'filled' || o.state === 'canceled') {
          this.store.removeOrders(orders);
        }

        if (o.state === 'live' || o.state === 'partially_filled') {
          this.store.addOrUpdateOrders(orders);
        }

        if (o.state === 'filled' || o.state === 'partially_filled') {
          const market = this.store.markets.find((m) => m.id === o.instId);

          if (market) {
            this.emitter.emit('fill', {
              side: orders[0].side,
              symbol: orders[0].symbol,
              price: parseFloat(o.fillPx),
              amount: multiply(parseFloat(o.fillSz), market.precision.amount),
            });
          }
        }
      }
    }
  };

  handlePositionTopic = ({
    data: okxPositions,
  }: {
    data: Array<Record<string, any>>;
  }) => {
    const positions = this.parent.mapPositions(okxPositions);

    if (positions.length) {
      const used = roundUSD(sumBy(okxPositions, (p) => parseFloat(p.mmr)));
      const upnl = roundUSD(sumBy(okxPositions, (p) => parseFloat(p.upl)));

      // OKX doesn't sends position side for net positions,
      // so when we are closing a position and contracts become 0,
      // we can't tell if it was from the long or short side.
      //
      // To fix this, we keep in store "virtual positions" for both sides,
      // and when we receive a position update with 0 contracts, we update
      // both virtual positions.
      const updates: Array<
        [Pick<Position, 'side' | 'symbol'>, Partial<Position>]
      > = positions.flatMap((p) =>
        p.contracts === 0 && !this.parent.store.options.isHedged
          ? [
              [
                { symbol: p.symbol, side: PositionSide.Long },
                { ...p, side: PositionSide.Long },
              ],
              [
                { symbol: p.symbol, side: PositionSide.Short },
                { ...p, side: PositionSide.Short },
              ],
            ]
          : [[{ symbol: p.symbol, side: p.side }, p]]
      );

      this.store.updatePositions(updates);
      this.store.update({
        balance: { ...this.store.balance, used: used || 0, upnl: upnl || 0 },
      });
    }
  };

  handleAccountTopic = ({ data }: { data: Array<Record<string, any>> }) => {
    const totalCollateral = roundUSD(sumBy(data, (b) => parseFloat(b.totalEq)));

    this.store.update({
      balance: {
        ...this.store.balance,
        free: subtract(totalCollateral, this.store.balance.used),
        total: subtract(totalCollateral, this.store.balance.upnl),
      },
    });
  };
}
