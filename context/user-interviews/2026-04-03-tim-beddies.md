# Interview: Tim Beddies

- **Date**: 2026-04-03
- **Role**: AI automation freelancer/agency
- **Duration**: ~30min

## Background

- Investment process work: CRM, Excel
- Currently uses Python scripts, faster than n8n
- Hosts on Coolify (Docker on Hetzner)
- Each Python script gets its own Docker container with FastAPI schema
- Uses Claude skill for deployment, 90% less time
- Has a deployment pipeline: GitHub branches, CI tests, DB staging -> prod
- ~15min for deployment

## Current Stack

- Python + FastAPI per tool
- Docker on Hetzner via Coolify
- GitHub CI/CD pipeline
- Claude skill for scaffolding

## Pain Points

- **Observability missing**: no dashboard with tools overview, no proper alert system (e.g. API key expired)
- **Hosting fee management**: clients want their own servers, needs to charge them
- **White-label / branding**: clients want their own brand UI (colours, theme, design system)
- **Maintenance billing**: they pay for maintenance but no platform to show value
- **Browser management**: managing browsers for different projects is messy

## What They Want

- Dashboard with all tools visible
- Proper alerting (API key expired, errors, etc.)
- White-label UI per client (Next.js dashboard)
- Activity logs
- Branded experience adds premium value, feels unique/one-off to the client

## Floom Fit

- Comfortable with current solution
- Missing: observability, client-facing UI, white-label branding
- Hosting fee pass-through to clients
- Brand customization = premium positioning

## Key Insight

- The value isn't just running scripts, it's the **client-facing layer**: branded dashboard, observability, activity tracking. That's what justifies ongoing maintenance fees.

## Action Items

- [ ] Check E2B vs GCP pricing for hosting model
- [ ] Feedback button feature: always save both dump and parsed versions
- [ ] Consider white-label/theming as a feature
- [ ] Observability dashboard (tool status, alerts, API key expiry)

## Transcript

Date: Apr 3

Transcript:

Me: Do you have GitHub organization so that we can just Yeah. Create purpose there? Can you invite me? Yeah. I love that. He's ready. He's coming out to the call. He's trying now with you. Хотим. Oh, yeah. Now I hear you. Yeah. Yes.
Them: Nice. How are you doing?
Me: I'm good. How is it going for you? How's your day?
Them: All good. Lot of work, but, very
Me: Yeah. For ourselves, intents.
Them: nice day. Can imagine.
Me: Ity. Yeah. Yeah. So met earlier today, Tim. Already told you. We actually just talked to Ma here.
Them: Mhmm.
Me: He was a really nice guy. He cool guy. I was really surprised because I arrived at the office and then blood showed me his prototype. And he built it today. And it's 10 times better what I've built in, like, last month. So I think we should show it to you. Because it's it's really cool. But do do you want to ask quest a question first, or do you wanna dive into it directly? Yeah. Yeah. Maybe I think it would be cool to figure out, like, what kind of automations you like, doing the most so it's can figure out how to make it easy for you.
Them: Mhmm. So what kind of automations you mean? What kind of business pros we are working on? Or
Me: Take that down.
Them: Okay. So for example, at the moment, working a lot on automating investment processes, especially in in the real estate sector. So it's a lot about kind of, like, getting data from different sources. So email, WhatsApp, some kind of information from data rooms, and then putting it all together. The right information out, automating it, the whole adding it to CRM, building kind of, like, a first prototype exit from its exit model. So that's that's what I'm mostly working on at the moment.
Me: And how's the data looking? So you have just conversations with, someone through email, WhatsApp, and you want to integrate them all together?
Them: Yeah. So Yeah. So it it sometimes depends. Like, sometimes the information come from WhatsApp, So we have kind of, like, a WhatsApp pooler that just puts out the data. Then sometimes it's just for brokers through the email. And then data rooms are additionally, I would say, just coming in the later stages where they where they provide us with some more information and and all that. So at the moment, we try to kind of, like, automate the whole pipeline from basically getting the first offer to the point where they have a full investment model and can already see basically is this a good investment or not.
Me: That's that's ambitious. But cool. Yeah. Like, what's the whole process? Can you just tell, like, steps in from Hidewell overview?
Them: Yep. Yep. So let's let's say we get a offer from a from a broker. Usually, it comes through email. We have a basically, a pulled email email address where all the offers are sent to. And then we just pull out all the new offers, extract the information, using, both some just easy text to AI some OCR through mostly Mistral at the moment. Because it's the only one that is usually usable through the GDPR guidelines. And then all the information out, we have a basically, format for all the new offers that we needed at the end. Then usually creating a short PDF summary, like, a executive summary and then afterwards, uploading it all in the CRM. The moment most companies are working with are using Salesforce.
Me: K. Cool. And what do you already tried to do?
Them: So first, and we
Me: With it? Like, how did you try to automate?
Them: So first MVP was in NATN. So just to get an understanding of if the whole pipeline works in general, Second one was through just different Python scripts. Using a Python Python Orchestrator script. So first of all, another techie I don't know a lot about that. I know just that it's least working at the moment. And so, therefore, it's like an we have a orchestrator Python pipeline and it has different kind of, like, steps which it can then, you see, pull out information and then give information back to the to the orchestrator. That's that's the main part of it.
Me: And what was better? Python or NDA?
Them: And so that Also definitely Python, just for at first of all, speed was way faster. Usually, it then took, like, I don't know, five minutes per per offer for Python. In,
Me: Tschüs.
Them: like, under a minute. And, also from a observability standpoint, also way easier to to understand, like, where the errors where the passwords are really working out, especially when because we already launched kind of, like, a prototype into production. Just seeing it in real life. And, therefore, it was a little bit stressful when something broke and then it end, and then you had to fix it manually. I think it was was not a good day.
Me: Yeah. We also love Python more and much more. Was using NNN for a long time ago, but not anymore. He just wiped codes in a few minutes, and it's working. Yeah. And, how how do you currently run this Python script? Are you holding them there, or you're just locally running them?
Them: No. Hosting it on the Hudson server with setup. So each each Python part is basically kind of like a separate Docker container. Then a resource on on Coolify. And, yeah, mostly running it for that, and then we have, like, a fast API wrapper around, all the processes.
Me: And, like, how long did it take, like, course, building script is one part, and making it available to everyone or, like, with the company is another part.
Them: Yeah.
Me: How long did it take to deploy everything?
Them: So in the in the beginning, very long because I had no idea about deployment whatsoever. So it was, like, every step need to be run prelegated. Basically, a closed session in my browser open, just asking it for every step. Now I have to kind of, like, a playbook that I just wrote down, put into kind of, like, a Claude script or, a a Claude skill.
Me: Yep.
Them: It just and now it's, like, 90% less time. I think all these just very minor adjustments I need to do, and now it kind of, like, the whole deployment pipeline itself with all the GitHub branches. CI tests, and, yeah, also some some automations in the background that migrate the database when I move it staging into production.
Me: Nice. And, like, after you already figured it out, how much does it take right now? Like, how many minutes?
Them: I would say let's say, fifteen minutes, I guess.
Me: Okay. Yeah. And, like, if the if, like, do you have a way to figure out, like, what is running currently? What are my automation that's available? And how how do you detect errors? All this, like, observability stuff.
Them: I am. And that's something I'm currently figuring out.
Me: How do how do
Them: I I usually have a dashboard with the tools that are running. Each company I'm working with. They they basically have kind of like a like a interface where they can see the tools they can use already. And as I have usually like, I'm currently setting up, like, a proper reporting system for me and, a proper alert system. That that shows me when something breaks. There's substantial number of same errors on on one project or if there are some problems with the PRs.
Me: Okay. Good. Yeah. That sounds exactly that, like, the problem we're solving to just completely remove deployment parts because basically, you don't really need to do this at all. It's not something brings value. It just something that you have to do it. It's not really important stuff. Yeah. That's cool. Do you have a question maybe before we go into demo?
Them: I'm very excited about the demo.
Me: Think we'll do the demo. Yeah. I've built it in like a few hours
Them: Yeah.
Me: yesterday on evening. But it, like, shows the core workflow, how it should work ideally at the end. Yeah. Like, maybe you can already think about some workflow that you want to automate. Maybe, like, not very big, but, like, some Python scripts that can do some work.
Them: Let's say pulling an email and analyzing the intent. And providing me with, like, a summary of, I know, the the main or kind of, like, summarizing all the events that have high intent for for buying. Is it too complex?
Me: Okay. Like, We can do it with an app password. From from Gmail, for example. Yeah. So to make it more specific, like, go to Gmail take unread emails, analyze them, and give me ones that are potentially, like, interestingly commercial. Yeah?
Them: Yeah. Yeah.
Me: Okay. Go to Gmail, read unread emails, Ana find out which ones are how do you say it? Like, you can sell to them or what?
Them: Yeah. Let's let's say they have a high intent for for business with us.
Me: Okay, yeah sounds good. And give me reports on which should act. Yeah. I didn't try yet, to do Gmail integration, but let's see how it works. What information does it need as input? Yeah. Gmail password, because I already have one. Okay. Yeah. Yeah. So you don't have to give the API key. Passwords. And run it every morning on 07:00. It to you on WhatsApp. Cool. It's okay? Ah, yeah. Sorry. And what output should look like Table with sender subjects or text summary? Yeah. I think table is good format for this. Yeah. Yeah. Department, sales Yes. So I never thought about this, Tim. Because my idea was just, like, everyone just writes their own apps. Then they use, prune to to to deploy it. But Vlad had had this idea to actually make it a questionnaire. You'd say, it easier for everyone. And now it's building the alternation already.
Them: I think it's very smart.
Me: Yeah. I I also I thought the same.
Them: Because then you need to basically give them the the script afterwards and say, okay. You need to adapt your project.
Me: Exactly. Yeah.
Them: You already get them to perform it. Yeah.
Me: And, also, user can, like, don't know any, like, some questions that like, some specifics about automation and questions can figure it out. So yeah. Okay. Go for it. Yeah. Looks good. I think you still have to give the email and password, or will it just do will this be an input field? Let's let's give it, like, Secrets needed. Mail. You know? The question is, are the secrets now Yeah. I think we can do it now. Ok. Okay. Automation needs Gmail, email, Okay, here we go. Sorry. One sec. Because we have some certain secrets. Yeah. In a potentially. Once secrets are already in the system, you don't have to set up it twice. So it's like Exactly. Like, if you have two apps and you set it up once for the first app, second app already has it.
Them: Yeah. Okay. That's So basically, having shared share
Me: Yep. Sorry. And and then probably get here. No worries. Are you going home for Easter, by the way? Or are you staying in Berlin? Yeah.
Them: Going home tomorrow?
Me: Okay.
Them: Take the ride's back.
Me: Where do you Right?
Them: And yeah. Very close to Rauschke called Wolkenmettl. City Of Jägermeister.
Me: How's it going?
Them: Ja. Wolfenbüttel.
Me: I know Wolfenbyttel, Hi-Familien Wolfenbyttel.
Them: Really?
Me: Ja,
Them: No way. Okay. That is insane.
Me: ja,
Them: It was, like, 50,000 inhabitants.
Me: Yeah. I know I've been there.
Them: Oh, that's good. Did you like it?
Me: Yeah. But there's, like, there's a nuclear reactor or something close to it. Right?
Them: Yeah.
Me: Yeah. Yeah. Yeah.
Them: Yeah. It's a nuclear storage
Me: I was
Them: Yeah. It's to say, like, they I think it's not super close, but there were, like, huge protests when they when they started to store nuclear waste there.
Me: Oh, yeah. I imagine.
Them: It so.
Me: Crazy. I think the app is already. Right?
Them: Nice.
Me: Yeah. So it basically gives you a link to the platform where you can see
Them: Yep.
Me: the dashboard. And, yes, some summary. Let's go to it. Here we go. Gmail high intent scanner automation. Let's go. Max emails to scan. Yeah. It can't be anything. It can't be API. Or MCP. Yeah. I I don't know what's this thing on top of it.
Them: Yeah.
Me: It's, like, from Google Meet. I think you can just 30 is fine. Let's see if it works. Actually, I don't know if it will work out. Didn't do it with Gmail yet. But, basically, the whole workflow is it, like, you build it together with this skill, it deploys it automatically, and you don't have to worry about deployment at all. It's already Let's see if it works. And you get the that the you get the UI auto fetch from, like, the input and output output fields. These are correct email emails. Yeah? They are real.
Them: Nice.
Me: Mhmm. Yeah. And you can bunch a lot of them together into this, like, big process. Because, you know, probably one big Python is not very maintainable. But many different ones is very good.
Them: I think it's
Me: You can reuse them.
Them: I think that's very cool. And it's super fast.
Me: If we would give it to you right now, like, production ready, let's say, would you buy for it? Like, for example, let's say, €30 per month.
Them: It's good good question. I've think it depends on also the requirements of the customer inquiry you're working with. Because, for example, some of them, they need like, if I can use this and basically deploy myself on the server, maybe it will work because they usually want own and they're just required to have own servers and not, hosted in the cloud. At least the ones I'm currently working with because they're very like, they have very strict regulations on on from financial standpoints. And so data is a very big topic there. Think the problem is I feel like I for me, myself, I've already the problem 90%. So I don't think I will pay a lot of money at the moment, to be honest, because I am very comfortable with with the solution I worked out for now. I think if it depends on like, if all the the parts around it, so the the alerts and so on,
Me: Yeah.
Them: are also kind of, like, part of the product because of what's think it would help me a lot in terms of just observability. Because I now kind of, like, switch between five different servers try to figure out if everything is running right.
Me: Yeah.
Them: And of course, I can now build all these kind of, like, setups when basically say, okay. Are all tools online? Is everything running? Are there any problems? Any deployment logs that are that that shows some some errors? But it's at the moment, it's very manually for me. I'm just still working on the solutions for that. So, yeah, I think it depends on the kind of, like, on the format of the final product.
Me: Yeah. Definitely. Observability will be part of the product because it's important to monitor. And even self recovery when it's possible. Like, if something was broken, it just can
Them: Yeah.
Me: fix it.
Them: Yeah.
Me: You don't have even to fix a lot of issues. It's very impressive that you have this pipeline, makes it done in fifteen minutes.
Them: Makes sense.
Me: Yeah. That's good. I don't have it. Very cool
Them: I think actually, it's like I kind of like because I I had no idea about deployment, so I just mapped, like, the whole deployment process, and now it just goes for every step after after step. And it has all like, I'm using, how's it called?
Me: Mhmm.
Them: I have no idea what it actually is, but it's kind of like a e n v r c or something. Is basically, in my repo, and it get if I'm in the right repo, it gets all in for, like, all the keys from, the the main kind of, like, the the workspace, the project, the underlying project. So it just pulls all the keys from there, and then deploys it through API mostly. Mostly Qualify at the moment.
Me: And do you have, like you probably have very decentralized pricing. Like, you basically have to pay for a lot of tools. To host all this.
Them: Yeah. I I mean, that's yeah, that that's true. So I at the moment, I I'm kind of, like, charging them hosting fee. So I'm I'm they can either set it up on their own servers, or I say, okay. Can set it up for you on the German server, monitor everything, so on. Therefore, the DevOps part is only there I need to set it up on on a new server. But I can at the moment, at least, can just pass through all the costs and charge premium for the for the monitoring.
Me: Yep.
Them: Otherwise, won't be possible.
Me: Okay, cool. Yeah, okay. Monitoring will be next thing afterwards. Anything else that would be, like, important for you to have?
Them: Let me think. So one thing that is that is very important, actually, at least for for some of our clients, They want to have it in their own brand UI. So if they want to use it too, and it's not a headless one, they always want it in their specific brand colors, brand theme. Sometimes they even have, a full design system. And so they it like, at least my experience was that they don't want generic looking ones. They want to have a kind of, like, a white label solution that they can customize for their for their own liking. But
Me: Cool. And and how so, basically, my understanding is you build automation,
Them: Yep.
Me: you give it to them, and they just, like, work with it. Like,
Them: Sorry.
Me: do do they have in it, or they come back to you afterwards?
Them: Sorry. What what did you ask?
Me: For example, if if something is not working as they expect,
Them: Yep.
Me: back to you or they fix themselves?
Them: I know. No. It depends. Usually, I'm basically saying project then I on top, repayment. For maintenance and everything else that that needs to be added in the end. So just kind of like a very small retailment fee that is recurring for the next twelve months is usually included in the contracts.
Me: And did you figure out how to host on their service? Like, is it not big problem for them to host on their own? Do they have, like, enough expertise, they just
Them: So that's a good point. Luckily, in the moment, the problem, they need to host on their server. So, sorry, usually, like, for for now, I always set up a new server for them. Because, also, sometimes I feel like they're a little bit skeptical about already putting it on their own servers. And so they want to have it kind of, like, actually separated by infrastructure basis. I think it's rational. Because it just adds a lot of DevOps and the monitoring in the end. But it seems like some of them are very skeptical about what AI can do and how it's different.
Me: Makes sense. Okay. Yeah. I mean, it feels like you are basically building everything that we are trying to build. Your own. We can only deliver the customer if we are faster. If we basically make it a no brainer.
Them: Yeah. I think if you actually make it a no brainer, you can you can offer the the same specs I can I can do now? Maybe even with a better experience. I think it would be a safe bet. Because then for me, it would be like, I could it's it's got I think it's a very nice product for for all these upcoming agencies. Because you can literally just sell it to them, and they can pass through the costs and just say, okay. We just charge a premium for that even. So I think it's in this case, it's a very no brainer for me.
Me: I mean, yeah, you also always have to think about, like, what's what's your,
Them: Yep.
Me: ROI. Right? And if you if you can do with, things faster,
Them: Correct.
Me: it's good. But
Them: Agreed.
Me: how do you how do you like, where do you visualize all the agents
Them: Yeah.
Me: or automations that you have
Them: So, can't show you production one. I build the app. So, usually, what I do is I get them a very easy front end just kind of like a platform. So usually call the platform. And there's everything from the manual agent's workflows they can use for one of tasks. To the headless ones where they basically see all the kind of, like, runs it did all the results from that. And I mostly do it just with a very simple NextJS dashboard. Kind of like it's always the same. It's like they have a very simple introduction page. A tools page, a dashboard, kind of, like, with monitoring. And then some admin settings. Mostly more is not needed.
Me: Is there maybe not production data, but, like, can you show something else to us so that, like, I just see how everything looks together?
Them: Yeah. Let me see. I can show you some what's okay. Let me
Me: Very impressive what you have built, to be honest. There's one person on them.
Them: Very nondeath. Right? Okay. Let me let me show you something. Just need to to find because my that that will be actually a very good solution. And managing many different browsers for different projects
Me: Sí, sí, sí.
Them: in a very easy way.
Me: Do you know Mark Browser?
Them: Because that's something yeah. I the problem is with always wanted to start up with it. Then I saw it's depreciated and not not really not really updated anymore, so I'm a little bit hesitant.
Me: Yeah. They have a
Them: But would you say or would you advise me to to switch on
Me: So Arc is nice because you can
Them: Yeah.
Me: switch between tabs. But for me, the big was that it's very high consumption on RAM. It is. Actually, there is open source version and is much more efficient. But I didn't like some feature, so I didn't switch to from work. Yeah.
Them: Yeah.
Me: But but I think they already improved because I tried one year ago. You have True.
Them: Okay. I can
Me: Seeing it. Yeah. Right now, I'm proud.
Them: well, let me see, show you something. So please
Me: Yeah.
Them: keep this competition because it's like the
Me: Yeah.
Them: wait. I need to make sure you can see this. So it's it's very easy. So that's basically the cockpit that you kind of, like, very short introduction. Build a very simple tutorial for them. How to use this, and then they have kind of, like, here like a how's it called, fast access. And then here, have all the tools. So the tools now this is like a staging from, like, two months ago or something. Here you can see how the are kind of, like, set up. And if we would go into one, they're always kind of, like, the same So they they have, like, a input field on the left. Last run here, then you can see all the runs, from before. And then I have a monitor section. This is I said it's like a it's a very early stage, so it's not very accurate at the moment. It looks a little bit different now. Then just a simple admin section for managing all the users and tools.
Me: Так Сколько?
Them: That's it. So that's that's kind of a yeah. Sorry.
Me: It looks very cool. Are you using it, like, for did you develop it for particular customer, are you reusing it for
Them: No.
Me: many customers?
Them: No. I'm I'm mostly reusing it. Like, I build kind of like a how to call it? The skeleton, and then I just have different UI components, just different components. They can just switch with the brand colors and f so usually build all the, like, the the whole design system in in the Figma. And pull it into a markdown and then create all the components from that. And then it basically just so I have the the kind of, like, the skeleton framework for that, and then it just exchanges them.
Me: One hint if you haven't heard of this approach, but I don't use Figma. I use Cloud Code to create HTML wireframes.
Them: Ah, yeah.
Me: And they look exactly how the real product looks like.
Them: Yeah.
Me: And you can this. Yeah.
Them: So the the thing is I'm I'm not really using actually Figma. I'm using a Figma clone because it's free
Me: Ok.
Them: it's called pencil dot dev, and I'm mostly using it because I feel like it's very easy to edit the wireframes because then you can just go into the wireframe, click around, pull something there, and then I just say, okay. Cloud. Go ahead. Just copy your wireframes. One like, 100 percently correct. And usually, it's like it's very, very efficient with the
Me: Pencil of dev. Nice. Yeah. I heard about it.
Them: very But they the problem is they they have a very strong lock in because you can't export their files. I didn't saw that in the beginning. So they they you can import Figma files, but you can't export them anymore. And they already announced that they will add pricing. So I'm now looking for a new one.
Me: Yeah. The MPC pressure to get ARR right. So
Them: Yeah. Yeah. Yeah. So sure. They're also backed by, I think, a six in that speed run.
Me: yeah.
Them: And so it seems like they need a lot of AR now.
Me: Do you think this branding customization adds some premium price for you?
Them: Yeah. Definitely. Because the the generic thing is basically unsellable from my perspective. If thinking from an agency perspective, the because if you customize it for them, they feel like it's a one off thing you bid for them. For them, it looks like first of all, it looks unique. Second, if they already have a brand system and you can replicate it 100% correctly, then it looks so much more premium from their perspective. And that's the point. I I don't think the they are they they care about the experience they have, when they see this, it looks hive, like, functional, and then that just works. Like, that they don't have to care about. At least that's my experience now. Maybe
Me: Yeah. I think you really cared about building it particularly for them, so it works best
Them: Yeah.
Me: for them. So, yeah.
Them: Which technique is true. Like, I build most of the kind of, like, the back end things
Me: That's good.
Them: just for one customer, like, try to build replicatable things. But in the end, some things are just one off per customer. But the front end, I feel like, is not necessary to have, like, one dash of everyone.
Me: Cool. Dank je. Do you have allôdov? Reusable code? Like, let's say, like, across many projects, what's the core like, how many percentage of the code you reuse across all of them and many is custom? And what is custom part?
Them: That's a very good question. I was yeah. Honestly, I'm very bad at this. It could be like, I I would say I tried to replicate as much code as possible, So if I see, for example, like, frameworks that I could use in another, in another project, I tried to replicate it as much as possible, but it's always in different repos It's always so I just copy the call. It's not linked. There's no no correct way of doing it for you.
Me: Yeah. Okay. Cool. Yeah. Yeah. Super insightful. Like, Do you have I think thanks a lot for your time. I really appreciate it. We already overnight. Like, all of It's very impressive what you're building there. Wow. If we can support you in anyways, let us know, please.
Them: That's super kind of you. I'll definitely come back.
Me: Yeah. Good question. That's just set me up.
Them: That's super nice.
Me: And if if you know if you know any other person that is also using, like, Cloud Code the way you are,
Them: Yep.
Me: we we talk to more people because this is super insightful. Yeah.
Them: Ik zie een nou someone, who built the whole company production code base with Cloud Code, and it's running it up. I can so I can definitely connect you with them because I'm currently cold with him. They can ask him if he wants to open the call with you as well. Depends on when you are free.
Me: No.
Them: And Okay. I'll ask him. Worries. No, but very much big thanks for the for the demo. Looks very cool and promising.
Me: What are you trying it when it's,
Them: And
Me: production ready and maybe for customers who are not requiring custom
Them: yeah. Definitely. I I
Me: deployments? On their
Them: Definitely. I I mean, I would love to try it because I would simplify my workflows. Would be very nice, and would be very very helpful.
Me: Yeah. We'll make sure
Them: Nice. Thanks, guys.
Me: Next team.
Them: I asked him if he came up in the call, and then I I send him your number, Phil.
Me: That's all great. Thanks Tim. Thanks a lot.
Them: Bye, guys.
Me: Bye bye. That was incredible. Yeah.
