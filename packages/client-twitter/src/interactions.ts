import { SearchMode, Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to kindly RESPOND than to IGNORE.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of kindly RESPOND rather than IGNORE if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };
        handleTwitterInteractionsLoop();
    }

    async handleTwitterInteractions() {
        elizaLogger.log("Checking Twitter interactions");

        const twitterUsername = this.client.profile.username;
        try {
            // Fetch mentions, replies, quotes, and retweets
            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    `@${twitterUsername} OR to:${twitterUsername} OR quoted_tweet_id:${twitterUsername}`,
                    20,
                    SearchMode.Latest
                )
            ).tweets;

            let uniqueTweetCandidates = [...mentionCandidates];

            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;
                const interactedToday = new Set<string>();

                for (const username of TARGET_USERS) {
                    try {
                        const userTweets = (
                            await this.client.twitterClient.fetchSearchTweets(
                                `from:${username}`,
                                3,
                                SearchMode.Latest
                            )
                        ).tweets;

                        const validTweets = userTweets.filter((tweet) => {
                            const isUnprocessed =
                                !this.client.lastCheckedTweetId ||
                                parseInt(tweet.id) > this.client.lastCheckedTweetId;
                            const isRecent =
                                Date.now() - tweet.timestamp * 1000 < 24 * 60 * 60 * 1000;
                            const isFirstInteractionToday =
                                !interactedToday.has(tweet.username);

                            return (
                                isUnprocessed &&
                                !tweet.isReply &&
                                !tweet.isRetweet &&
                                isRecent &&
                                isFirstInteractionToday
                            );
                        });

                        if (validTweets.length > 0) {
                            interactedToday.add(username);
                            uniqueTweetCandidates.push(
                                validTweets[Math.floor(Math.random() * validTweets.length)]
                            );
                        }
                    } catch (error) {
                        elizaLogger.error(`Error fetching tweets for ${username}:`, error);
                    }
                }
            }

            uniqueTweetCandidates = uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.client.profile.id);

            for (const tweet of uniqueTweetCandidates) {
                if (
                    !this.client.lastCheckedTweetId ||
                    BigInt(tweet.id) > this.client.lastCheckedTweetId ||
                    tweet.isReply
                ) {
                    const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
                    const existingResponse = await this.runtime.messageManager.getMemoryById(tweetId);

                    if (existingResponse) {
                        elizaLogger.log(`⏳ Already responded to tweet ${tweet.id}, skipping.`);
                        continue;
                    }

                    elizaLogger.log("✅ Processing new tweet: ", tweet.permanentUrl);
                    await this.handleTweet({ tweet });
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                }
            }

            await this.client.cacheLatestCheckedTweetId();
        } catch (error) {
            elizaLogger.error("Error handling Twitter interactions:", error);
        }
    }

    private async handleTweet({ tweet }: { tweet: Tweet }) {
        if (tweet.userId === this.client.profile.id) return;
        if (!tweet.text) return;

        const userId = stringToUuid(tweet.userId); 
const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);

const state = await this.runtime.composeState({
    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
    agentId: this.runtime.agentId,
    userId,
    roomId,
    content: { text: tweet.text, source: "twitter", url: tweet.permanentUrl },
    createdAt: tweet.timestamp * 1000
});


        const validTargetUsersStr = this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");
        const shouldRespondContext = composeContext({
            state,
            template: twitterShouldRespondTemplate(validTargetUsersStr),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });

        if (shouldRespond !== "RESPOND") {
            elizaLogger.log("Ignoring message");
            return;
        }

        const context = composeContext({ state, template: twitterMessageHandlerTemplate });
        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        if (response.text) {
            try {
                const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);

await sendTweet(this.client, response, roomId, tweet.username, tweet.id);

                await wait();
            } catch (error) {
                elizaLogger.error(`Error sending response tweet: ${error}`);
            }
        }
    }
}
