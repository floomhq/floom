# Interview: Mahir Isikli

- **Date**: 2026-04-03
- **Role**: Tech lead / engineering at Arbio
- **Company**: Arbio (~60 FTE)
- **Duration**: ~30min

## Background

- Manages hotels, agents, internal tools at Arbio
- Uses staging -> prod deployment pipeline
- Has dealt with mistakes when staging -> prod goes wrong

## Pain Points

- **API key access management**: no proper scoping, agents don't have read-only access
- **Proxies for APIs**: not properly scoped, unclear which access is used
- **Blast radius**: expects things to break, wants to reduce blast radius
- **Browser automation**: needs to spin up 50 browser sessions
- **Testing**: testing itself is hard (Vercel portless), needs regression tests to rollback
- **Procurement friction**: 3 months to get Exa web search approved in F500 environments
- **PDF generation**: broken, needs fixing

## Current Stack / Tools

- OnePassword for secrets
- Background agents
- Browser use (spin up 50 sessions)
- Granola for extracting data
- Vercel for hosting
- n8n for prototyping (ops team prototypes, eng team builds)
- Lovable, Supabase
- Claude Cowork (some people use)
- Proposio for Google Sheets
- React PDF for document generation
- Signed public URLs

## What They Want

- **Human guardrails**: reduce blast radius, don't ship incorrect stuff
- **Agent-first deployment**: non-dev friendly, 5min demo
- **Product guardrails**: how to prevent bad outputs
- **Agent for guardrails**: an agent that checks other agents' work
- **Regression tests with rollback**: testing framework for agents
- **Internal OS**: centralized tool management
- **Voice agents**: wifi details, office tasks
- **Education**: teaching non-devs skills (git, backups)
- **Self-service tools**: invoice generator (React PDF, signed public URL)

## Use Cases Mentioned

- Pi/Py (OpenClaw) - permissionless agent access
- OpenClaw agent that shows all X likes
- Doctor's office: Mac Mini with speech-to-text
- Ops team prototypes in n8n/Lovable, eng team productionizes
- Making non-devs not need devs

## Key Insights

- **Guardrails are the #1 concern**: both product guardrails (don't ship bad stuff) and access guardrails (scoped API keys)
- **Agent-first, non-dev deployment** is the pitch that lands
- **5min demo** is the bar for adoption
- **Procurement is a blocker** in enterprise (3 months for a web search API)

## Connections

- On-Deck Fellowship
- Founders Inc

## Action Items

- [ ] 5min demo flow for floom
- [ ] Guardrail agent concept (agent that validates other agents' output)
- [ ] Regression test / rollback framework
- [ ] Scoped API key access model
- [ ] Write blurb for Founders Inc

## Transcript

Meeting Title: AI agents and production deployment strategies with startup founder
Date: Apr 3

Transcript:

Me: Oh, yeah.
Them: Oh, hello, guys. Hi there. Emma here. I
Me: Sorry for the
Them: sorry for the for the waiting room. I didn't see it. And this is Vlad. Hey, Vlad.
Me: this is last.
Them: How's it going? How's it going? Good. And you? We I
Me: Good. You have with I just met with you in the morning.
Them: I just met Tim in the morning. Which Which
Me: This is didn't know which
Them: I didn't know which Tim? I mean, sorry. Tim is such a
Me: I mean, I know it's a
Them: Oh, it's a name. Tim, like, which I I would have said they're name, but I also don't know they're last name anymore. I have to check. I love it. Nice. Where are you guys based?
Me: second. There's the campus.
Them: In Delta Campos. Delta Campos. Okay. Nice. It's super close. I live at the
Me: Oh,
Them: Zutchden, like, you said in Hemopods right here. Oh, nice. Cool. Yeah.
Me: I mean, if you want to come over,
Them: Mean, if you want to come over, Depends on how long you wanna talk because I would have to just go there then.
Me: Also,
Them: Also,
Me: yeah, maybe
Them: yeah, maybe to give a bit of context.
Me: So
Them: So
Me: nice to meet you.
Them: nice to meet you. Nice to meet you. Vlad and me, we just met on Tuesday.
Me: Und
Them: On added, like, a cofounder matching. Nice. I I build a
Me: I I build
Them: I build a start up. Like, we both have been building start ups last two years.
Me: My
Them: My last start up was called Scale. It was in the AISCO space.
Me: We scaled it
Them: We scaled it to 600,000 ARR with
Me: people, which was pretty cool.
Them: three people, which was pretty cool.
Me: Automated everything.
Them: Automate everything.
Me: And I also saw it because I was
Them: And I also saw, like, because I was, like, deep deeply in cloud code as as I told you, like, three x
Me: deeply So
Them: max subscriptions. I I saw many issues, like, that that come with it.
Me: that come with with using agents, especially on the
Them: Like, using agents, but especially on the
Me: production
Them: deployment production side of things. Yeah. And
Me: side of things. And yeah, Tim told me that you and I like,
Them: Tim told me that you are, like, running some events here.
Me: running some events here, like, a talking investor.
Them: Like, a anthropic ambassador. So I thought you probably have used Cloud Code as well.
Me: And
Them: And would would just like to tinker a bit about this topic. And and hear your opinion. And, Vladimir, we just like
Me: And here we go. Another meat our motivation,
Them: our motivation, I I guess, and correct me if I'm wrong,
Me: building time important that
Them: is, like, building something that's useful for humanity, and we really think it's important that agents are easy build and deploy. Yeah.
Me: And, well,
Them: Yeah. Well, lovely to meet you guys. It's funny. So think it's a big issue, like, also, like, one of my agents, and I started working at, like, a start up called RVO. Like, a month ago. First freelance and now full time a while ago. And
Me: it didn't, like,
Them: didn't break something, but it is stupid mistake, you know, where it pointed something that should have been staging towards
Me: something
Them: production, and it didn't do anything. But you guys are guys who can do this. But I think that was a really good experience because now we're like, okay, guys, how do we set up our infrastructure in a way where we think about giving agents read only API key accesses And one of the things what we do is basically buy up property management firms that, you know, manage your apartments, hotels, hostels, whatever. And create another layer on top. And so one of the APIs we use kind of to connect with the like, I think
Me: so channel.
Them: channels like Bookings, PDF, Airbnb, they don't have read only scoping. So it means if you gave an access that is, you know, like, everything, then it could do everything. You know?
Me: Mhmm. You know?
Them: So, like, how do you deal with that? And one of them being like, okay. Maybe you use proxies. Right? You create your own proxies for the APIs that don't have proper scoping.
Me: And
Them: And you unlock which accesses were used. Right now, we're looking into, do we wanna use
Me: and
Them: like, one passwords AgentCLI. Right? That has, like, service counts and stuff when I never thought about using one password. I'm, like, a dash end user. So thinking I really like these ideas of
Me: Okay.
Them: okay, expect it to be broken
Me: A
Them: Just reduce the blast radius as well as possible. I mean, you guys can tell me maybe you're already doing way more than I am, but I'm really like I love what a lot of, like, the background agents are doing. Setting up environments, the browser use stuff. Right? Where, like, everything that you do gets tested, not with you writing playwright test or something, if it's your stuff. But you just spin up 50 cloud know, like, browsers. And I'm I'm literally telling this people like, oh, we need this. We could just do this on our Mac mini that we use for OpenHome. Like, no. I don't think I we can do 50 browser sessions at once, like, you know, like, with proper installs and different branches and whatever. So my way of working and I think it's also still, a work in progress, is, you know, try to reduce as much as possible work trees, scope it down, make sure it tests things itself. If if I wanna run things locally, I use, like, Vercel's port list to start multiple kind of like, local hosts at the same time from the same projects, right, to test things at the same time. And I think I know that I'm the human part that's gonna also make mistakes. So I'm trying to understand, okay, how do I reduce my blast radius, you know, with I'm not doing as much yet, but it's definitely, okay. Let's we're getting to the
Me: Freaking
Them: point where we're rebuilding an internal product that we're using to manage, like, these, you know, like, units and stuff.
Me: And
Them: And you don't wanna make you don't want to ship incorrect stuff
Me: we
Them: because the end users are not gonna know that it's incorrect. Right? And they're gonna base some decisions on this. So right now, we're making sure to define processes a lot more in detail. Everything's obviously a granola meeting node. You take that You extract all of this. You also get kind of, like, the okay alignment from internal teams. I mean, if you're, like, two, three people, it's something different. Right? Who we're a team like, we're a company of 60 people. Product engineering is, like, I think, eight to 10 people. So there's already, like, there's processes that live within and, like, notion and stuff. So by way, stop me whenever. But, like, it's really, like, it's more, like, specifically the the business that I'm in. Like, I I was working at, like, an American public in the Berlin office. So it was, like, public. Right? Fortune for found these companies. High bar, you know, for everything and compliance and everything.
Me: And
Them: And I hated it to something, but I also, like, oh, I know now what that means.
Me: I hated
Them: Right? Like, procurement taking three months to get, like, extra web search You know? And I'm like, what the fuck? You know? But
Me: You know? But one
Them: once you understand that, you can also think about, okay, what's the benefit of that? How can you deal with that? So I know there are, a bunch of people that I mean, a topic, putting, like, Hotmail and then getting the whole cloud code repo and NPM. Right? You're like, you know, that could happen. You know? Like,
Me: call know? I
Them: you might review some of the code still. You might not. Right? We can be very honest certain things. It'd be it's it's you're you I think these days, one thing that I think is very valuable is product thinking, business understanding, creativity, Right? All those sorts things that are, like, on topic of shipping. There's a lot of creative stuff in there as well. Right? Creative ways of how do you make things work together. You know? Also, like, my colleagues now have, oh, they're leaving their laptop open with caffeinated. Like, still locked. So, like, Claude code can do the computer's thing from lab from, like, a remote. Haven't even used that because I'm using Pi. You know? So I'm like, I'm not even so much in the Claude code thing. I'm using Opus, obviously, but, you know, I'm also not
Me: What's the time?
Them: loyal to just that. Right? It's more like What's So Open Cloud is using Pi
Me: So
Them: the coding harness, because Pi a cording harness built from this Austrian guy called Marian Cesner. That is permissionless by default. So that means there is no approval flows. Necessarily. So it's like Yolo mode and then so. And you it's model agnostic, provider agnostic. So kind of what you see, I think, like, with Open Cloud now, like, right, like, the last day or something or so on x, it's like that, but for the last few months, and you can extend it with your own tools You can it's basically, like, a very, bare minimum coding harness. Even ship with web search, and then you have to build all this. It's fine. First, you're like, what the fuck? I'm so used to cloud code and stuff, but then you I see the benefit of being able to define things exactly where I want. Just on the skill level or whatever, but I can build my own custom tools that are always exposed to the agent. I don't use MCPs directly but, like, we are a proxy tool that is calling them via CLIs. That means I never have context bloat because of, like, tool locations. And I'm like, sure. I could also use, like, tool search, right, and all of this, but I'm like, I don't know. It works for me quite well. Right? So for me, there's a lot of, like, custom ways working, and I've shared this with my colleagues, and they're always, like, oh, this is so cool. And I'm like, yeah. Like, you gotta be on X. You gotta see the new thing, and then you gotta experiment. You gotta like stuff. I have, like, my own kind of, like, open college where once a week, it shows me all my x likes and all my, GitHub likes, like stars. And then kind of, like, what's important from this? What's interesting for me to deep dive into something? So
Me: Think
Them: think I don't know. I mean, I love your topic of helping humanity. I think you can help humanity with very simple things. You could help go to, like, German kind of, like, practices, like doctor's offices, and try to find a way for them. Hey. Let's set up a Mac mini for $650 or a thousand bucks or whatever with, like, open source speech to text running on this so you can transcribe your calls automatically then have stuff happen like that or have that run. Right? Think more compliance stuff. Think more GDPR friendly stuff. Health care stuff. Right? Like,
Me: basically,
Them: basically, make that more affordable or open source. Right? Like, these German companies don't benefit from as, like, open source at all as much as other people do So know we kind of, like, I I kind of, like, drifted here. Stop me whenever you want. But I think my thinking of this is also, at the other day, it's also fun. Right? I think we're very young people. We're having fun. We're going to this events. Maybe we hop on to travel somewhere, but it's so my way of working with Claude, GPT, maybe, like, Cerebros, GLM, point seven, you know, sort of things. It's like, make it work for your things. It's gotta break. Reduce the blast radius.
Me: You know?
Them: Right now, internally, I'm trying to create this mindset as well. You know, I just joined, like, six weeks ago. I'm like this new Gen Z kid even though nobody else is as old. It's like that's like let's just break things. You know? Let's just we have purely testers. Let's have agent browser running 50 kind of, like, times per regression. And we pay, I don't know, $5 or $10 per test, like, per per deployment to production. You know?
Me: So,
Them: So I guess it's a it's a bit you figure it out when you work at a specific place.
Me: It's a
Them: Also depends on your your specific needs compliance, so much industry in. Right? Like, I have friends working in, like, banking, and I'm like, yeah. They could talk do the same thing, you know, like, core AI banking, like, in SF or something.
Me: You
Them: It's very different. Right? So it depends, I guess, on what you're saying with braking. You know, and how much technical excellence you want.
Me: And because
Them: Because
Me: you know,
Them: you know, if you I mean, one thing we're doing right now is, like, make sure we have infrastructures code so we can easily roll back very quickly. If there's, like, some regression, you know, ideally, even, like, in a way where you can automatically roll back when there's some regression in sees, you know, or user report internally in, a Slack channel or something, writes this. Can easily roll this back. And all about if we ship so much so quickly, how do we make change logs easy and, like, product changes visually easy to see, and I'm thinking, there's the Vercel web real kind of repo. Which automatically can also do, a playwright thing, take a video of the new thing, okay. It's basically, like, thinking about the product, product education, because if you are not doing a good job, it's on you. Right? Like, it's part of your job as like, now I'm a product engineer. Before, I was an AI engineer. Right? The titles don't matter as much anymore. Have to be able to communicate. You have to be able to talk with people. And create trust and create trust in a way where they would
Me: don't
Them: don't think that why don't we just do this unlovable, you know, Why is this so hard? Why is it taking so long? You know? So that was a very long preamble. But I hope that was helpful. Do you have questions, Lars?
Me: Do you have questions now? Yeah. Go. Like
Them: Yeah. Cool. Like, what's the
Me: what's the latest thing you are building?
Them: latest thing you're building? We're building, like, an internal platform. To manage these reservations on different units we have. So we have, like, 800, 900 units. Germany, I think, are, 10,000,000 ARR. Going for, like, a series b right now.
Me: And
Them: And
Me: so
Them: so you must imagine you can't imagine how shitty he used different platforms are to help you, like, manage. So if you ever been to a hostel and you're like, oh, can I change rooms or something in there? You've experienced that at your hotel. Right? There's these management software, and it's usually not amazing. It's not Stripe like Airbnb, like whatever you're a linear, you know, far from it. Trying to create a bit more something like that, know? And also start trying to start
Me: And, also,
Them: bringing up voice agents for customer service. For certain use cases. Right? We're thinking about confirmation flows, thinking like, build a demo for some investors that we're talking with right now. Like, you call, you're able to mean, did you think about just, like, able to get the Wi Fi details to about everything details, all the things that you might not easily have access to if you have as great of an app as, like, Airbnb. Right?
Me: Yep.
Them: Yep. And thinking about, hey. I wanna
Me: And
Them: I have to leave in a day early. There was some construction. Or I want my invoice and, like, okay. I get my invoice directly via Twilio SMS. Or their workflows, and things get automatically routed. Right? So there's a lot of stuff that we can do, and I feel like the team is trying to overcomplicate a bit. I'm like, guys, let's just strip things and try and try and So voice agents, internal AI platform where you can extend things, get things easier instead of, like, UI. Right? A lot of people are playing around with generative UI, and you're like, okay. What can we actually do? AISDK v six is quite great from, you know, the get go. And then you think as well, what what permission flows do you wanna have? What can just easily work well? Right? How do you work with the third party API providers to make sure things work correctly? Bit like role based access. Part of this is the AI stuff, right, that helps things. A part of it is still classic
Me: Yes.
Them: business engineer a a business context product engineering.
Me: It's classic platform, but we're curious about
Them: So it's classic platform, but we're we're curious about
Me: how go to market and if you're able use plot code.
Them: how go to market and admiration people use, plot codes because right now they can wipe
Me: Because right now they can wipe with a lot of stuff.
Them: a lot of stuff.
Me: Like, we're curious if
Them: And, like, we're curious if Yeah. Your company
Me: your company, it's all something like
Them: using yeah. Yeah. Good question. They're using we have a operation team's quite enabled on Lovable with N8N.
Me: And
Them: And super base. So it's a bit hacky, but it works.
Me: So
Them: Quite well. So what I'm trying to do more and more I mean, I joined six weeks ago, and I'm like,
Me: some of what I'm happy to do is
Them: let's productize this. Right? You start building this first in Cloud Code or in Vlavable, then we take this these repos and build these things properly. I help some of our operations people as well to get set up with cloud code and, like, speech to text, you know, like, local, like, using a hierarchy model and, like, man, now my colleagues are like, I shared this with everyone. I'm so much faster. I talk. And I'm like, of course. That's how I've been working for, like, a year and a half at this point. Who types anymore?
Me: And
Them: And
Me: there?
Them: they're doing, I think, quite a good job as well of testing this.
Me: I think I didn't play a job as well.
Them: Because they also know that if they fuck up, you know, it's on on their kind of on their sheet. And, we we have some people on our finance teams as well that use Cloud Cowork, and I really like this. This so cool when it works. And I think we could even elevate them more if we give them some more understanding of what works well, maybe help them create skills right, or certain hooks to make sure things works. Because what if what do you how do you explain to them, you know, like, that it will start being shit at, like, 150 k tokens, maybe you don't even see that as well in, like, cloud cowork. Right? And if you do give it file system access and it deletes something, and they have backups because they're not obviously using Git for Excel or whatever. No. So thinking about, okay. How do you you know, programmatically help them them set up connections to Google Sheets with, like, some set party provider like Composio, make sure that it instead uses CSVs, downloads, and map those debts and draws copies just to think about
Me: You know,
Them: you know, it will fuck up. Right? And if you
Me: know,
Them: like, you don't wanna overwhelm this and then be, like, it's so hard. Like, no. No. No. It's fine. We just have to talk about this. You know? Like, there needs to be some kind of onboarding. To a reasonable degree because if you just have the power of doing this yourself, it's really easy as well to fuck things up. Obviously, we all have probably had our agents or, like, I would pipe because permission is delete something and is like, there wasn't a backup of this. That was annoying, but you deal with it. Right? You you learn from this. You you learn your agents I mean, the models get much better and better. And, if it's not like a model regression or something from someday where it's like, it's, 50 IQ points tomorrow, then usually, it also doesn't happen.
Me: Yeah. That's true.
Them: Yeah. That's right.
Me: Do you have questions?
Them: Do you have questions for them?
Me: Pardon?
Them: It's extremely interesting to hear your
Me: To hear your important
Them: input dump. I love it. Very interesting to hear how you how you work
Me: love it. Very interesting
Them: So I think the the most effective thing is to show the demo.
Me: So I think the the most effective thing is to show the demo. Oh, yeah.
Them: And maybe so
Me: The idea is
Them: the idea is
Me: that you can basically create agent automation.
Them: that you can basically create agents or any automation
Me: As you are already doing your boot camp, but
Them: Mhmm. As you are already doing it with craft code. Mhmm. But
Me: But the thing is that we want to make the production layer on top of it.
Them: the thing is that we want to make the production layer on top of it.
Me: In one click.
Them: In one click.
Me: And that's the thing we are working on.
Them: And that's the thing that we are working on.
Me: Because right now,
Them: Right now, if you wanna deploy something you still have to have, like,
Me: if you wanna deploy something, you still have to have, like, server who's thinking. You have to have, like,
Them: server hosting. You have to have, like, rate limiting security. You have
Me: great learning security. You have to have a UI
Them: to have the UI
Me: all of them.
Them: all of that.
Me: And for me, as an under,
Them: And for me, as a non dev, this was like an extreme challenge.
Me: this was, like, an extreme challenge. And I always off the tool that that now
Them: And I always dreamt of the tool that Vlad now built.
Me: So
Them: So let's just do a quick round of testing.
Me: let's just do a quick round of testing. You can give us any idea of, like, an agent.
Them: You can give us any idea of, like, an agent
Me: Let's let's think of something very simple.
Them: Let's let's think of something very simple.
Me: And, obviously, like,
Them: And, obviously, like,
Me: I will not
Them: I will not constrain you too much. Just just say what what what whatever you have on mind.
Me: Yeah. Maybe you have you know, some workflow that
Them: Maybe you have you know, some workflow that operations
Me: operations or go to market people already, like, have
Them: go to market people already, like, have
Me: and we just can create this right now.
Them: and we just can't create this right now. Yeah. Let me think about what you can do without real API or something like that. VoiceAge is also a too tricky because you need a level IP also works. We just need to have the API key, but I have for most of the tools, so I think it will work. Yeah. Like a self-service invoice generation tool. Right? Go for that. It can be mock data.
Me: Okay.
Them: Mhmm.
Me: Invoice generate
Them: Invoice generator. Que era decir,
Me: Let's see what it does. Okay. So, yeah, what's in those?
Them: Okay. So, yeah, what's the input? What's the input? So I have my personal details, you know, like a normal reservation, name, address, then the duration of the stay. Let's say April 1 to April 3, like, until today. Total cost per night is €100 per night, one guest in total, and tax rate is 19%. And then maybe there's a city tax of, like tax rates.
Me: Sorry. Didn't get that one? Percent. That's correct. Extract. Sorry.
Them: Tax rate. Don't know. €3 per night as well that you have to consider. True. Yeah. Tourismustaxe. Okay. Tourismustaxe, genau.
Me: Okay. Let's go.
Them: Yeah. Do you want PDF or
Me: Yeah. Do you want PDF? Or
Them: PDF. And I mean, I like JSON Render or like React PDF.
Me: Yeah.
Them: So if you just wanna write that as well. Let's see. I mean, rack PDF is quite nice. So you guys wanna productize this, like, where do you see the different channel to, like, lovable? Because, like, what what pricing model or something you you think or, like, usage based pricing?
Me: Hello?
Them: So that's from our perspective.
Me: From our perspective, it's gonna make it cool.
Them: From our perspective, it's an amazing tool. Mhmm.
Me: The way it started
Them: The way it started is, like, shiny magical landing pages.
Me: shining
Them: Just appear if you do one prompt.
Me: which
Them: But we think that
Me: the real magic happens
Them: the real magic happens if you can automate very boring tedious tasks.
Me: she can automate a very mono
Them: What do we need the APIs for?
Me: do we APIs for? I think I'm trying to
Them: Maybe, I mean, API to generate
Me: Yeah. It's it's a stupid question. Actually,
Them: Yeah. That's a good question. It's well, actually, we we don't know we don't need the API.
Me: know, I
Them: If we have the input, it just renders the output. Right?
Me: Yeah. Just
Them: Yeah. I think yeah. I mean, I built this. That's why I mean, give you an example of something. Very good. Yeah.
Me: Here you go.
Them: And the nice thing here is kind of, like, what I did is have it create the PDFs ad hoc have them, like, in a super based bucket. I don't know if it's called bucket or blob source or something. Mhmm. And then have it on, like, a signed public URL. That's not, the ugly super based URL. Or, like, mean, we do use AWS internally normally, but I wanna use AWS shit. It's too much and too expensive generally. So this is really nice because yeah. Then you can also send it via SMS. Right? That's the whole thing. Like, that that's, I feel like, the best flow. If you person calls, they don't I mean, then just send it to their number, you know, once you, like, do the KYC or, like, authentication authorization process or whatever. Amazing. Sounds really cool. Yeah. So
Me: Amazing. How's it? Yeah. So
Them: Lovable. Magic your websites. We say magic is in the boring task, and the
Me: magic conversa.
Them: second one is that we think our hypothesis is we go agent or agent workflow agnostic
Me: whether you use
Them: Whether you use Pi or Cloud Code, doesn't matter. We give you the production layer for it. And we don't try to nail everything at once.
Me: And we don't try to overmail everything at once. Just try to work in production there.
Them: We just try to lay nail the production layer.
Me: That's it.
Them: That's it. Because cloud code is already amazing.
Me: Because
Them: Mhmm. Production layer, meaning, like, hosted database, auth, all of that, a bit, like, super but, like, Vercel makes and eight and makes lovable. Think more production. So okay. I I mean, I got the thing. Like, ideas then, like, how do you make sure there are guardrails from, like, a product perspective? That even if user does want something stupid, you'd do it better.
Me: That's a very Yeah. I think we'll need to figure it out.
Them: That's a very good question. Yeah. I think we need to be alone.
Me: It's, like, a serious process.
Them: Like, continuous process. Let's check the app that we just built. Yeah. Guest name. Okay.
Me: That's, like Yeah. I guess, name. Okay. Maxed.
Them: Max Yeah. You have to figure out by where which Tim, because I really don't know which Tim you mean. I'll I'll figure it out for you. One second.
Me: Yeah. Looks good.
Them: Yeah. Looks good.
Me: Let's see you later.
Them: Let's see. Let's run. Mhmm. Well, never tried to
Me: Never tried PDF, guys.
Them: PDF exports, so curious if it will work out.
Me: So curious it will work out. Invoice
Them: PDF. Invoice PDF. URL? Or generated some blob. No. It's probably
Me: It's probably not here. Yeah.
Them: Yeah.
Me: Something probably.
Them: Something for our list. Generation is a big one. Right? And, like, obviously, like, unstructured data and stuff. Yeah. Organizing is a small event for, like, VC automation on Tuesday. At, like, antics, like invite only. And then big is, like, unstructured data to structured data for deal flow and stuff, right, for VCs. That sounds amazing. Yeah. Maybe we should go there.
Me: That sounds great thing. Yeah. Maybe we should go there.
Them: It's only invite only for if you're in a best store. Sorry. Okay.
Me: Okay. Okay. Yeah. Here right now, but it's, like,
Them: Okay. Yeah. The did work out, but it's like
Me: producing.
Them: And I know though. So, I mean, like, what are the guardrails that you guys
Me: So
Them: thinking about? You know, how do you how do you create such like, another layer on top that's maybe partially prompt based or hook based? Or another agent afterwards based that that if this goes like, being published internally or something, that you make sure you have something that is safer because, I mean, those are the same challenges that Level has. Right? User will do something stupid, and they will obviously share APIs. Keys or whatever through the chat. And it's never gonna say, oh, don't share the API key here. Just go into the dashboard and add them there. Nobody wants to do that. Right? So you have to find, like, the the Goldilocks zone of convenience for a nontechnical user. They could also just go end up using cloud code. And it mean, they're using cloud code. Right? But doing the hosting part via you where it's easier to use you compared to just setting up Subabase in Vercel. And those are not hard to set up. Right?
Me: Yeah. True. In my previous company, when I worked with a work building
Them: In my previous company where I work, we were building voice agents for big and there's,
Me: agents for big enterprises, and there's, like, guardrails that must have because it's
Them: guardrails must have because it's airlines banks.
Me: airlines banks. So
Them: So what we did is having agent who is
Me: what, we did is having agent who is additional agent who is guardrail only.
Them: additional agent who is guardrail only.
Me: Basically, test the main agent who generates code or doing other stuff
Them: Yeah. Which is just the main agent who generates code or doing other stuff.
Me: and just
Them: Just which is independent, has rules which are written down.
Me: which is independent, has rules, which are written down. Per particular enterprise.
Them: Per per particular enterprise and just checks it every time.
Me: Just checks it every time.
Them: And in general, like, so you talked about
Me: And in general, you talked about education that you have to give to your teams, for example.
Them: education that you have to give to your ops and GTM teams, for example.
Me: Staging,
Them: Staging, versioning,
Me: of all of that.
Them: all of that. Yeah. Obviously, this is something we have integrated.
Me: And, obviously, this is something we have integrated with. So you have
Them: So you have of one app, you have different versions.
Me: one app. You have different versions. And you you can decide which version of this.
Them: And you you can decide which version is is serving on production.
Me: Is serving production. So actually being used
Them: So actually being used. And, obviously, you also have stuff like
Me: And, obviously, you know, in it then.
Them: you know, NetNN. Like, NetNN has, like, secrets stored.
Me: Has, like, secrets to storage. We can just use them.
Them: We can just use them.
Me: And this can be secure.
Them: This can be secure.
Me: So you don't have to fix the, like, the secure stuff every time you build an app.
Them: You don't have to fix the, see, like, the secure stuff every time you build an app.
Me: It once.
Them: Just do it once. Yeah. Yeah.
Me: App
Them: I mean, it's like the whole using coding agents to do the review on your PRs as well. Right? Like, code is generated by them, and you go lever like, like, another layer with agents. And I do see there somewhere being the break Right? Like, some architectural things, being hard to see. Right? Because it's not incorrect or you, like, you have just one agent or do you have 20 agents run from different perspectives with different skills right, or, like, different focuses.
Me: Yeah. That's
Them: Yeah. That's, like, the thing we're like, okay. There are some good points that our senior kinda, like, engineers are bringing up or, like, our tech bring up, and I'm like, we can deal with that. I think we can ship quickly and then find it. Try to find a way at the same time to deal with this and see where it breaks at same time. Right? So you will have you have to push your limits of what you're okay with to understand what you then need to create as a guardrail because you can't just do, like, waterfall planning of this is all the issues that we're gonna have when we do this. Right? Okay. You know, I see this. So I mean, but what's your I mean, I used to do it also, like, a five months VC internship. So I have, like, the what's your USP kind of mindset? Like, how do you see this being, a clear differentiator? Because if I mean, there is some value for sure. I agree. Right? But then there's also the there's, like, the perfect zone of you don't know enough about tech for this to be valuable. Right? But you still need to know a bit Right? Like, you still need to be able to use the CLI and children are starting to learn to use cloud code and stuff. Right? So it works to be like, where where do you position yourself a bit? Like, right, like I said So, like,
Me: Nondevelopers
Them: nondevelopers
Me: are our ISP, especially, obviously, like, those that are using
Them: are our ICP, but especially, obviously, like, those that are using
Me: magenta coding.
Them: agentic coding for anything, any tool. Cloud Code, Cursor can be anything.
Me: Or anything any tool, clockworkers, And all of them
Them: And all of them will face the same issues don't know what Docker is. They don't know how to host on the server. Or do they even get the server?
Me: I'll do I'll tell them to start about. Stuff like that.
Them: Stuff like that.
Me: Yeah.
Them: Yeah.
Me: Advanced, not technical users, but not like my mom. Yeah.
Them: Probably advanced, not technical users, but not like my mom.
Me: She will never get it to it. And also, like
Them: And also, like,
Me: the go to market should not be human for it.
Them: the go to market should not be human first. It should be agent first.
Me: This is a protocol which agents just use the
Them: Yeah. The protocol which agents just use because they know it, and then you have URL of something, and it just works.
Me: does work. That's where we want to get.
Them: That's where we want to get to. Like I like this agents first,
Me: Like Yeah. Agents
Them: nondeveloper deployments.
Me: Yeah.
Them: So that could be your website.
Me: What I see? Screams for it.
Them: I see it Yeah. Guys, I'm think I mean, I'm I'm trying to organize another cloud code meetup this month or next month. Mhmm. Guys kind of, like, get the demo going well and something that can be done in, five, seven minutes, more like five minutes, and then talk about it. It could be maybe, like, a good talk because I do wanna get some people that are good presenters. You guys seem smart. For for that. So if you're interested and the dates work out because there is no date TBD yet,
Me: Yeah. So
Them: and you're So
Me: when is it? Because, like,
Them: is it? Because, like, April 15 Mhmm.
Me: April 15. we are starting
Them: We are starting in an incubator in SF.
Me: Yeah.
Them: Yeah. Nice. Which one? Founders Inc.
Me: Nice. Founders Inc.
Them: Yeah. No. Okay. Nice. It's probably not gonna be until then. Okay.
Me: Okay.
Them: Because, still, you gotta I mean, I'm probably gonna use it in, like, the space. We we share space with
Me: Hello.
Them: Yeah. We I was in the office last week in office.
Me: I was in the office last week in Vancouver. So good.
Them: Yeah. Yep. So we're on the 5th Floor. Like, we share a lot of space with them and everything.
Me: Cool. Right.
Them: Right. But it's to
Me: It's too I mean,
Them: I mean, we could do it, but I just need to get the okay from an topic as well, like, always for these.
Me: it's
Them: Quickly gets approved. So, another time. But nice founders, Inc. Is it, like, three months, two months?
Me: Six weeks.
Them: Six weeks. Six weeks. Okay.
Me: Yes. Yeah. But if we can make it
Them: Yeah. But if we can make it, we will let you know. And anyways, like,
Me: if you have people
Them: if you have people
Me: that are that you can think of from your, like, network,
Them: that are that you can think of from your, like, network,
Me: or maybe what's it that we can just, like,
Them: or maybe WhatsApp group where we can just, like,
Me: get some people to talk to interviews, like, the moment that's with you.
Them: get some people to talk to interviews like the one we just did with you.
Me: Especially not
Them: Mhmm. Especially nondesk.
Me: that
Them: That might face these issues would be amazing.
Me: face is that you would be amazing. I think it's the best thing we can do now to people.
Them: It's the best thing we can do now, talk to people.
Me: Yeah.
Them: Yeah. None that's right. Because, mean, I feel like I'm not your ICP. I think I'm asking a bit more.
Me: Yeah. You're talking about
Them: Yeah. Too advanced. Unfortunately advanced than me.
Me: you're more
Them: I am an engineer at the end. Yeah. But let me think about it. Yeah. There's some people. I think it's, like, user interviews, yes, but I'm like, I don't know if they're gonna give you any new
Me: usage.
Them: Oh, a 100%. I do think so.
Me: 100%.
Them: Okay. I'll think about it.
Me: Yeah. Like,
Them: Yeah. Like like, seeing how people work and just asking questions is, like, magical.
Me: seeing how people work. Yeah.
Them: Do you guys have, like, a good network in San Francisco?
Me: A bit
Them: A bit. A bit. Not not amazing.
Me: not not amazing.
Them: Was there just, like, last week, like, until Monday, like, this this week Monday. No way. Yeah. And I could connect you with, like, one friend that, like, leads on deck fellowship. Think maybe she would call to have, like, a coffee with or something. Nice. That'd be amazing. Yeah.
Me: Hope you made them Yeah.
Them: Send me I mean, I have your name, Federico and Vlad. Just, a blurb quickly. Yeah. Know Farnest think you'll be there for six weeks and all of that. And then I can ask him. Mean, I was staying at his couch on his couch. So we're pretty good friends. Yeah. And so
Me: And so
Them: Ferre, you speak German. Right? Ich spreche Deutsch.
Me: E que e que me
Them: I guess you're I will Eastern European, I assume with that name.
Me: Yes. Russian. I Yeah. I'm Russian.
Them: Yeah. Russian. I I yeah. I'm Russian. Yeah. Okay. No. Perfect. Just thinking of, like I mean, some I know a guy that works at like, like, thinking of, like, where I could connect you with. Because I was also and I said the first time, like, a year and a two years ago. And I asked just a bunch of people, hey. Do you know someone to talk with?
Me: Mhmm. Then just
Them: Then just obviously trying to think about connections that could be interesting. Let me think about it as well. I can connect you with someone else while you're there because, obviously, that's the whole game there, all about networking.
Me: Yeah. Why are you not building?
Them: Yeah. Why are you not building something right here? Why are you in a company? Yeah.
Me: Yeah. That's the first time
Them: Get this question. I get this question asked guys so much. You don't even know. I did build something last year, like, the year before October until last year or March. And it was, like, in the, public tender space. So, like, public projects being given out. Right? And all the price And we also had, like, three pilot users. I did first engineering, then I went towards go to market because my other co founder didn't wanna do go to market. I heard just two of us. I was doing this full time. He was still working at Google. It's kind of like we were in our somewhere both all in, you know, and then we just both realized. Last year, like early March, we're not in this. Like, we don't live, breathe, public tenders and constructions in the German speaking market.
Me: And, like,
Them: And I gotta say, and I'm still at this point, I feel like a bit of my
Me: eagle,
Them: ego was broken.
Me: white,
Them: Or my kind of, like, belief in myself of being capable.
Me: Okay. Yeah.
Them: Very honestly. Right? Because it didn't fail. Like, we decided to stop it. But it's kind of like this was I mean, I was leading startup initiatives in Berlin. Did my VC internships, startup internships, finance associate. Right? Like, and then I was like, okay. This felt like the natural path for me to try this. And then I I felt I felt even though maybe I didn't. Maybe you you can see it wherever you want.
Me: So
Them: So I think this is still, like, a very
Me: the But that's the
Them: strong Oh, that's exactly, like, the the trajectory. Right? You have to fail a few times. You just have to believe in
Me: to it. Yeah. I'm trying for two years without success, but I'm still going.
Them: sticking to it. Yeah. I'm trying for two years without success, but I'm still going. Yeah.
Me: But I know the the mails
Them: I know. And I and I you had, like, I always
Me: also many times almost gave up, like,
Them: also many times almost gave up, like,
Me: So many times.
Them: some of that. And exactly the question asked me. I mean, I wanna be a
Me: And
Them: for sure. Right? I mean, I just turned 27 two days ago. So not the youngest anymore within the I'm not under 25 or whatever. But I'm like, you know, I also enjoy my life. I have healthy friendships. I go party if I want to. I was in Mexico for three weeks. Then as I have, like, I have a life. I have friends around the world. Like, I I've understood that life is more rich than just I have my friends in SF that do nine nine six, and I see them thriving career wise, but person like, personal life wise, not much. Right?
Me: And
Them: And I make seven I I make six digits now in Berlin. You know?
Me: I
Them: Like, base pay. So I have a pretty good life.
Me: So I
Them: And I don't wanna get into lifestyle inflation. But it also, like, I didn't grow up with money. So this is, like, very new for me. You know? So it's like this Obviously, you make more money when you have equity, but it's also, like, a bigger risk and everything. Right?
Me: So that's it.
Them: So to answer the question, I think I'll do it again. Maybe I'll do it within the next month a year. I have some opportunities maybe that line up in SF, but I like TBD.
Me: So
Them: So, you know, stay tuned. I I never know. You know? Like, I'm someone that also I mean, we probably are similar in this mindset. Right? Like, the able to just, like, do things, understand things, challenge things, help each other, think like this. Right? This is a small bubble of Berlin that is very much like this in a non VC transactional way, but, like, in a really I wanna help way. Right? Whoever that Tim is just thinking of me connecting you with me, right, or something like this, And then me now asking my friends connect them with you and all of this. Right? This is very natural for us. We would do the same the other way around. And I had the same thing last year when I was asking for go to market help. I love that. I'm not gonna miss I'm not gonna not have that. So know, think, I just need a bit of that. Okay. It's time. Like, either I do this now or I become complacent, and just go into the like, golden hand cuffs life. You know? Like, when you work with people, I always say you have the golden hand cuffs, and it's true. You make 150, 160 k based plus another $50.60 equity which is real valuable equity actually. Right? It's that life is very, very, very comfortable. Not lie. Marcia, Marcia, just to tell this to you. You would have been a better fit for this position but I was interviewing for roles in SF. Where I would have earned 3 to $400,000 a year.
Me: thousand dollars a year. Technical lead roles
Them: Technical lead roles, obviously, would be the better fit
Me: obviously, would be the better. I'm not saying, like,
Them: I'm just saying, like,
Me: I'm here because I I think there's, like,
Them: I'm here because I I think there's, like, so much potential in this AI thing.
Me: much potential in this area, I think. I think
Them: It is. There is. There really is.
Me: Yeah.
Them: Yeah. There is. You have an amazing spirit. Like, really cool to meet you.
Me: But that's you have an amazing spirit. Meet you. Yeah. Energy. That's great.
Them: Nice to That's great. Let me know if I can help you in somewhere. Let me know if you have, like, a waitlist, whatever. Or a new start I reach in for some people. Happy to put my name. I can send you my email as well.
Me: Let us know also how we can we use food for you.
Them: Yeah. And then I'll that'll get can be useful for you.
Me: I understand. Yeah.
Them: 100%. Yeah. Happy to. Yeah. Definitely. I'll ask you. Otherwise, if there's nothing else, yeah, happy happy Easter Friday. Continue hustling. Enjoy Delta. Maybe we'll see each other
Me: Yes, sir.
Them: you know, after if you guys come back to Berlin. And, yeah, let me know which Tim it is when you were. I already texted you on on what Oh, perfect. Okay. Nice. Yeah. Good to meet you. I'm here.
Me: I'm here. Bye. You. Bye bye.
Them: Guys. See you. Bye bye. Thanks.
Me: Nice guy. Nice guy.
