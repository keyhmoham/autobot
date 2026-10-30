import { Redirect } from "expo-router";
import { useCallback, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  heading,
  input,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

type WalletPage = {
  wallet: { balance: number };
  grants: {
    id: string;
    amount: number;
    remaining: number;
    expiresAt: string;
    status: string;
  }[];
  entries: {
    id: string;
    type: string;
    amount: number;
    description: string;
    createdAt: string;
  }[];
  billing: boolean;
};

/** Credits balance, grants, recent ledger, and a transfer form. */
export default function WalletScreen() {
  const { data: session, isPending } = authClient.useSession();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const action = useAction();
  const load = useCallback(() => api<WalletPage>("/api/wallet"), []);
  const wallet = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  const data = wallet.data;
  return (
    <Screen
      refreshing={wallet.pending}
      onRefresh={() => void wallet.refresh()}
    >
      <Text style={heading}>Wallet</Text>
      <Problem message={wallet.error || action.error} />
      {data ? (
        <>
          <View style={card}>
            <Text style={{ fontSize: 28, fontWeight: "600" }}>
              {data.wallet.balance.toLocaleString()} credits
            </Text>
            {!data.billing ? (
              <Text style={muted}>
                Billing is off; balances still update when credits are minted or
                sent.
              </Text>
            ) : null}
          </View>
          <Section title="Send credits">
            <TextInput
              accessibilityLabel="Recipient"
              autoCapitalize="none"
              onChangeText={setTo}
              placeholder="Handle, email or user id"
              style={input}
              value={to}
            />
            <TextInput
              accessibilityLabel="Amount"
              keyboardType="number-pad"
              onChangeText={setAmount}
              placeholder="Amount in credits"
              style={input}
              value={amount}
            />
            <Button
              disabled={
                Boolean(action.busy) || !to.trim() || !Number(amount)
              }
              title="Send"
              onPress={() => {
                void action.run("transfer", async () => {
                  await api("/api/wallet/transfers", {
                    method: "POST",
                    body: { to: to.trim(), amount: Number(amount) },
                  });
                  setTo("");
                  setAmount("");
                  await wallet.refresh();
                });
              }}
            />
          </Section>
          <Section title="Grants">
            {data.grants.map((grant) => (
              <View key={grant.id} style={card}>
                <Text>
                  {grant.remaining.toLocaleString()} left of{" "}
                  {grant.amount.toLocaleString()}
                </Text>
                <Text style={muted}>
                  {grant.status} · expires{" "}
                  {new Date(grant.expiresAt).toLocaleDateString()}
                </Text>
              </View>
            ))}
            {data.grants.length === 0 ? (
              <Text style={muted}>No grants yet.</Text>
            ) : null}
          </Section>
          <Section title="Recent">
            {data.entries.map((entry) => (
              <View key={entry.id} style={card}>
                <Text>
                  {entry.amount > 0 ? "+" : ""}
                  {entry.amount.toLocaleString()} · {entry.type}
                </Text>
                <Text style={muted}>
                  {entry.description} ·{" "}
                  {new Date(entry.createdAt).toLocaleString()}
                </Text>
              </View>
            ))}
            {data.entries.length === 0 ? (
              <Text style={muted}>Nothing on the ledger yet.</Text>
            ) : null}
          </Section>
        </>
      ) : null}
    </Screen>
  );
}
