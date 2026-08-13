/**
 * The five sample calls that ship in the repo, so the demo needs zero setup.
 *
 * Coverage is deliberate — one scenario per thing a rep actually needs the notes to catch:
 * a clean close, a call buried in objections, a competitor named out loud, pricing pushback,
 * and the one that goes nowhere. The no-decision call matters most: a notes product that only
 * works on good calls is a highlight reel, not a tool.
 *
 * These are written, not recorded, so there is no customer audio and no PII in a public repo.
 */

export type Turn = { speaker: 'rep' | 'prospect'; text: string };
export type SampleScript = { id: string; title: string; turns: Turn[] };

export const SAMPLE_SCRIPTS: SampleScript[] = [
  {
    id: 'clean-close',
    title: 'Northwind Logistics — final call, closed won',
    turns: [
      { speaker: 'rep', text: "Hi Marcus, good to see you again. Last time we left it that you'd walk the security review through with your team." },
      { speaker: 'prospect', text: "We did, and it came back clean. Security signed off on Monday. That was honestly the last real blocker." },
      { speaker: 'rep', text: 'That is great news. So on scope, we landed on forty seats across the two sales pods, starting first of next month.' },
      { speaker: 'prospect', text: "Forty is right. I would want the option to add ten more in the second quarter without renegotiating the whole thing." },
      { speaker: 'rep', text: 'We can write that in as a pre-agreed expansion at the same per-seat rate. It just needs to be exercised inside the first twelve months.' },
      { speaker: 'prospect', text: 'That works. And the onboarding, you said your team runs that, not us?' },
      { speaker: 'rep', text: 'Correct. Two sessions in week one, then a check-in at day thirty. Your managers do not have to build anything.' },
      { speaker: 'prospect', text: "Good. Send the paper over today and I'll get it through signature by Friday. Procurement already has the budget line reserved." },
      { speaker: 'rep', text: "I'll have it in your inbox within the hour. Anything you want me to flag for procurement directly?" },
      { speaker: 'prospect', text: "Just copy Elena on it. She's handling the vendor forms and she'll chase it if I'm slow." },
    ],
  },
  {
    id: 'heavy-objections',
    title: 'Halcyon Health — discovery, heavy objections',
    turns: [
      { speaker: 'rep', text: 'Thanks for the time, Priya. I know your team has looked at tools like this before and it did not land.' },
      { speaker: 'prospect', text: "That's right, and I'll be honest with you, I am sceptical. We rolled out a call recording tool two years ago and adoption was terrible." },
      { speaker: 'rep', text: 'What went wrong with it?' },
      { speaker: 'prospect', text: "The reps felt surveilled. It became a stick managers used in one-to-ones, and within a quarter people were taking calls off platform to avoid it." },
      { speaker: 'rep', text: 'That is the most common failure mode we see. Where does your team sit on the compliance side, given you are in healthcare?' },
      { speaker: 'prospect', text: 'That is the other problem. Anything touching patient information has to clear our privacy office, and they are slow and they say no a lot.' },
      { speaker: 'prospect', text: 'And frankly I do not have headcount to run another rollout. My team is already stretched thin covering two regions.' },
      { speaker: 'rep', text: 'So three things: rep trust, the privacy review, and no bandwidth to drive it. Have I got that right?' },
      { speaker: 'prospect', text: 'That is the list. If you can only solve one of them, solve the privacy review, because nothing else matters if we cannot get approval.' },
      { speaker: 'rep', text: 'Then let me start there. I will send the data processing terms and the deployment options, including the one where nothing leaves your tenancy.' },
      { speaker: 'prospect', text: "Send it and I'll forward it to privacy. I am not promising a timeline, they move at their own pace." },
    ],
  },
  {
    id: 'competitor-named',
    title: 'Bright Harbour Software — competitive evaluation',
    turns: [
      { speaker: 'rep', text: 'Before we get into the demo, help me understand what else you are looking at, so I do not waste your time on the wrong things.' },
      { speaker: 'prospect', text: 'We are down to three. You, Gong, and Chorus. We looked at Fireflies early on but it did not have the coaching side we wanted.' },
      { speaker: 'rep', text: 'What is pulling you toward Gong at the moment?' },
      { speaker: 'prospect', text: 'Honestly, our VP came from a company that used Gong and he trusts it. It is the safe choice internally, nobody gets fired for picking Gong.' },
      { speaker: 'prospect', text: 'The thing that bothers me about Gong is the price, and that we would be paying for a whole revenue suite when we want maybe a third of it.' },
      { speaker: 'rep', text: 'And Chorus?' },
      { speaker: 'prospect', text: 'Chorus was cheaper but the summaries were noticeably worse in our pilot. My reps stopped reading them by week two.' },
      { speaker: 'rep', text: 'So the bar is: summaries good enough that reps actually read them, without buying a whole suite to get there.' },
      { speaker: 'prospect', text: 'That is exactly it. And I need to be able to show my VP why this is not a downgrade from the thing he already trusts.' },
      { speaker: 'rep', text: 'Then the piece I want to show you is where every line in the notes links back to the moment in the call it came from. That is the part Gong does not do.' },
      { speaker: 'prospect', text: 'That would help. Send me something I can put in front of him, side by side, before our decision meeting on the twentieth.' },
    ],
  },
  {
    id: 'pricing-pushback',
    title: 'Cobalt Freight — pricing pushback',
    turns: [
      { speaker: 'rep', text: 'You have had the proposal a few days now. What is the reaction internally?' },
      { speaker: 'prospect', text: 'The product is not the issue. The number is. Fourteen hundred a seat is more than we spend on our entire sales tooling stack right now.' },
      { speaker: 'rep', text: 'How many seats were you modelling?' },
      { speaker: 'prospect', text: 'Twenty five to start. At that volume it is a six figure line item and it goes to the finance committee, not just to me.' },
      { speaker: 'prospect', text: 'And our CFO has been very clear this year that anything new has to displace something existing, not add to it.' },
      { speaker: 'rep', text: 'What would it displace, if it displaced anything?' },
      { speaker: 'prospect', text: 'Possibly the recording tool and maybe part of what we pay for conversation analytics. That is maybe half the cost, not all of it.' },
      { speaker: 'rep', text: 'So we need to close a gap of roughly half, either on price or on what it replaces.' },
      { speaker: 'prospect', text: 'Yes. And I would rather not go to committee twice, so I need the number to be right the first time I take it in.' },
      { speaker: 'rep', text: 'Then let me do two things. A ten seat starting tier so the first year is under the committee threshold, and a written comparison of what it retires.' },
      { speaker: 'prospect', text: 'Do that. If the first year comes in under fifty thousand I can approve it myself, and that changes the whole conversation.' },
    ],
  },
  {
    id: 'no-decision',
    title: 'Verity Partners — no decision, went quiet',
    turns: [
      { speaker: 'rep', text: 'Thanks for jumping on, Tom. I know things have been busy since we last spoke in June.' },
      { speaker: 'prospect', text: 'They have. And I should be straight with you, not much has moved on our side.' },
      { speaker: 'rep', text: 'That is fair. When we last talked, the driver was ramping the new reps faster. Is that still a priority?' },
      { speaker: 'prospect', text: 'It is still a problem but it is not the priority any more. We paused hiring in August, so we are not ramping anybody right now.' },
      { speaker: 'rep', text: 'Understood. Is there a point in the year where that changes?' },
      { speaker: 'prospect', text: 'Maybe January, depending on how the quarter lands. I genuinely do not know, and I do not want to give you a date that is not real.' },
      { speaker: 'rep', text: 'I appreciate that. Is there anyone else internally for whom this is live right now, even if it is not you?' },
      { speaker: 'prospect', text: 'Not really. Our enablement lead left in July and nobody has picked that up, so there is no one championing it.' },
      { speaker: 'rep', text: 'Then I do not think there is a deal here this quarter, and I would rather say that than keep booking calls.' },
      { speaker: 'prospect', text: 'I respect that. Check back with me in January and if hiring restarts I will tell you honestly.' },
    ],
  },
];
