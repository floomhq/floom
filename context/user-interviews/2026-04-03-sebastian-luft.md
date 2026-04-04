Date: Apr 3

Transcript:
 
Them: Car inspection hubs. Like if you're familiar with it. But I know if you have ever had a car in Germany, then you would know. Not Germany is a super place. That means your car needs to be checked once every two years by a professional to see that it's still, yeah, worthy to be on the roads and that it's safe. And this is done in inspection hubs. We are building this inspection hubs all around Germany. Standard VC bag start up and, yeah. We put the tech layer on top to kind of make all the operational processes more efficient and also have, like, some stuff on the customer side. Yeah? So what in the end, what you can think of us is, like, it's similar to maybe, Lieferando or Uber when you're order something, you see live tracking everything on their end. There's, like, perfect order management mapping drivers with yeah, with the customers and orders. Yeah. It's really simple to suggest that.  
Me: Yeah. That sounds cool. Automating really boring business with technology. That's amazing.  
Them: Yeah,  
Me: So, yeah, what's your, like, current automation, like,  
Them: So I'm in  
Me: how do you work with it?  
Them: general, what we do is and maybe maybe it makes sense. Like, for me, I'm, like, the only kind of tech guy on the team if I would even call myself tech guy. Like,  
Me: Yep.  
Them: yeah. But Yep.  
Me: Like many people right now using agents, CloudContin, but  
Them: Yeah. Yeah.  
Me: not really technical. Yeah.  
Them: Yeah. Yeah. Like for me, I'm kind of in between, you know. I, I have been coding myself for, like, the past eight years. But I have never like, I've only done it, like, twenty hours or ten hours a week I'm not, a full coder. I did, a coding bootcamp, la la la. This is all of this bullshit. You know?  
Me: Yep.  
Them: But, obviously, when Claude code hit, when cursor hit, when the LLMs finally got a bit more capable, and I could not no longer, like, was required to actually write the code, but just to read and understand it, it was way easier. So then, you would 10 x your potential there. You know? Like low potential is no medium potential. So yeah, this what I do. What we do is, like, we have several software platforms, I would say. Some are hosted via Vercel, some are hosted via like, the back end or back end lights. How I call it, via Fiber based functions. It's hosted right there. And, yeah, this is where we basically deploy our stuff automation wise. We also have like standard NNN workflows, Zapier, etcetera, but this is not, like, my my main part, like, our part is most of the time we have some scripts deploy it via sometimes railway. Sometimes Vercel, but Vercel has more more it's better, like, for the front ends. And, the back end stuff  
Me: Yep.  
Them: authentication, etcetera, is all done via Firebase.  
Me: Yeah. I'm actually more interested in scripts part. Like,  
Them: Mhmm.  
Me: now, you you said already using NNN? Like, who are people who are building it and, like, are they really happy still?  
Them: Yeah. So, what we usually do,  
Me: With this?  
Them: is, like, honestly, with N8M, I am not that big of a fan anymore because it's hard to build. In comparison to Claude Colt. Like, the the abstraction layer is just like, it's just it's easy to understand, but, like,  
Me: Too much. Thanks. Yeah.  
Them: it's hard to yeah, make it scalable and to get it past 50 nodes. You know? Then if you debug it, it's it's really annoying. It's a really process. And you can't get that like, in the development process of this whole automation.  
Me: Yeah.  
Them: Like, you hit a wall, and then I know, okay. If I would just pull the whole into a, a cloud code managed, automation, which is just a script,  
Me: Yep.  
Them: then I would be way faster iterating on it. So why we do it is because the business folks that build these automations, they don't fully understand the quote quote yet. They would also, which is, guess, your part, would be struggling with actually deploying it, making it kind of safe. You know? Not just, like, no calls, nothing. So we still use NNN because we want our working students and interns to be able to work with it. And don't have a black box which is not manageable by them. With the end in end notes, they can still see what's happening in  
Me: Yeah. Makes sense.  
Them: feel like they are in control.  
Me: So Python script no way for them. But, like, how do you manage currently your Python scripts? Of course, you can already read them. How do you deploy them? How you create them? What's the whole process?  
Them: Yeah. I'm I'll just walk you through quickly how like, like, how we also decided upon how we deploy. Like, usually, like, when you're, you know, one or two guys, they tell you what they did then you put it into your LLM of your choice try to, spare with them a bit, iterate a bit, and then see what makes sense for us. They, were like, okay. Back end. We feel it makes sense to with the smaller scripts just deployed via railway because it's fast and easy and it scales automatically. Yeah? This is then why we decided to do put it on railway.  
Me: And how long does And how long does it take to deploy with RIO? Is, like, a in minutes?  
Them: Like, I would say it's, like, first time one hour, then second time, five minutes. Because you just know what you're doing, right?  
Me: Yeah. All right. And what's your right now with, like, automation tech? What's the most frustrating part about creating this script? That are running?  
Them: Like, it depends how big, like, your script is. Right? Like, for us, what I do and deploy via script, this is usually really small stuff. For me, this is really small stuff. So I don't have a problem that I want to have a staging environment that I want to test it comprehensively because there are already some big processes depending on it. This would happen for me personally, this is then deployed via a Firebase function. Because it just needs to be more secure. You know?  
Me: Your  
Them: Then we have auth in there, everything. And then it's just easier to manage it and more secure. For the actual small small stuff, Like, for me, I didn't really see a big challenge, to be honest. Like, it was easy to deploy via railway.  
Me: Yeah. Makes sense. But what what is there, like, first reaching part of the whole automation? Like, maybe monitoring or observability?  
Them: Okay. Like, monitoring and observability, yes? Like, but it depends on what you're deploying. Right? If it's business critical, then, okay, I need to have it monitored and deployed for the smaller stuff we are deploying.  
Me: Yep.  
Them: Like, there I like, the pi I'm talking only about the Python scripts. And the scripts that we are deploying are really we are not monitoring them. Like, if it doesn't work, I check why it doesn't work and then redeploy it and to push it. Right? Push a change. And for the other stuff, like like, I I am trying to kind of get to your get to your use case a bit. But for us, our back end is mainly deployed via Firebase. And there we have Sentry. We have, like, other observability tools. Firebase, Crashlytics to actually have, like, some kind of monitoring. And, also, you can use the native Firebase  
Me: Yep.  
Them: integrations to just do everything. You know? But for the Python script,  
Me: Mhmm.  
Them: it's so small we don't really need it. Yeah.  
Me: Yeah. Then probably you're not ICP for us, but yeah, because you're, like, technical to figure out all the stuff.  
Them: Thanks so.  
Me: Yeah. We're more targeting people who are really not technical, who don't know how any back end, how authentication works.  
Them: Yeah.  
Me: Like, if you want to see, like, three minute demo, like,  
Them: Yeah. No. Me. Show me. Show me. Show me quickly.  
Me: just tell me. Because I think deployment here is even, like, shorter than  
Them: Mhmm.  
Me: five minutes. Let me share it. So, yeah, Just tell me which automation do you want to create. Like, very simple, something that you, like, have on your  
Them: That's all you wanna okay. Like, okay. Like, we do a real do a really simple part. Like, I mean, so you have, like, already, like, an automation build?  
Me: Yeah. Let's  
Them: Or you want to build one of Cursa quickly and then deploy it?  
Me: Yeah. Let's let's came up with some automation. We'll create and deploy. Yeah.  
Them: Okay. Then let's just say, we need, yeah. That's just the basic parts. Let's let's just say, create a database with 20, birthdays. And, when there's actually a birthday happening, there is like, a message sent via Okay. I don't wanna don't want don't want you to integrate now. Okay. Then let's do like, this this this doesn't make any sense. Let's just say there's an API call, and like, rest API, and we just do a random day of the month. Like, whatever. Or the current date, minus ten days or something like this. Like, really simple stuff.  
Me: Yes. Okay. Kids current day of the week. So, yeah, basically,  
Them: Okay.  
Me: So, yeah, basically, this skill is for both creation and deployment of the your file Python function.  
Them: Yep.  
Me: No inputs? Let's see. It can be basically anything at the end. It can be API. It can be MCP. It can be a form. Output is number.  
Them: That takes place a lot sense.  
Me: Text. Yeah. It's prototype just like built to into hours. But it should get idea how it should work.  
Them: Yeah.  
Me: No. Schedule.  
Them: Yeah. I okay. I I can maybe I misunderstood the product. Should have picked something more more complicated. I thought, no. I didn't know that  
Me: Yeah. Yeah.  
Them: We're not like, it's actually also about the creating part. I thought it was just about the deploying part. You know?  
Me: But at the end, it's all the same. Like, basically, Cloud Code, takes care of building the Python script. Is, like, integrating all your different tools. And it basically, at the end, creates script plus configuration for deployment. And, like, it looks good for me, for example. Let's say, go deploy it. Basically, the skill is responsible for both creation and deployments here.  
Them: Yep.  
Me: All together.  
Them: Okay. Anders how does, like, like, how does it work security wise? Like, like, I'm I'm just thinking if I hand this over to some of our business only guys they need some kind of automation.  
Me: Yep.  
Them: We connect it to our HubSpot, for example. I don't want anything to have the AWS API that's publicly callable. You know?  
Me: Yeah.  
Them: What is the issue or not?  
Me: I think we'll need to implement roles.  
Them: Mhmm.  
Me: Basically, how much can do. For example, can they publish, publicly, that  
Them: Yeah.  
Me: they don't publish something that is crucial. For your infrastructure. But yeah. Okay. So here we go. It published a link. Right now, have it locally. Here we have  
Them: Yeah.  
Me: list of automations, and here's the one that we just built. Let's run it. And we see output. So, yeah, basically, it's a  
Them: Okay.  
Me: the whole platform where your automations are running in the cloud on any triggers, on schedule, on a API call, MCP, whatever, or manually. And hope building and deployment process is just one session. How does it look?  
Them: Like, I I I understand. All makes sense. I will be super scared that, like, for me, this is the standard next step I would  
Me: Yeah.  
Them: do when I would be in a tropic themselves. Right? Like for me, this would be like the standard next step. Like this is how I felt like when I when I used Open Claw, I was like, man, okay. This takes a lot of time to actually train and set up. And I was like, okay. It's probably guy coming out in, one or two months. And then one week later, two weeks later, clocks, computer dropped. You know? Like, think it makes sense. It's a typical next step. But when I would be anthropic, I would be like, okay. This is a big pain point. Hey, man. It's, a big pain point. I will solve it, in the same, like, in the same product. I wouldn't need an external tool for this.  
Me: Yeah. Makes sense. I also had the same concerns. But, like, imagine would it be something useful for your technical people?  
Them: For our or non technical people. Then they have to scale, then they have to automation running. Like, from from when automation is actually deployed, how would you like, how would you how would the user experience actually be? Where would the like, would they always then go to the front end, click on the automation, then have the output there? Or would it be like an API they they have to integrate into  
Me: It can be can be anything, basically. Yeah. It can create  
Them: or or is it an MCP? It's an MCP. Right?  
Me: automatically create MCP, API, manual form, websites, link. It's basically, like, API is the source of truth. And the UI that the saw is like a wrapper around the API. And same for the MCP. Yep.  
Them: Okay. No. Got it. Got it. That's the thing. I think in general, yes. But the problem is that our folks are so non technical. I first have to do big how to what is an MCP? What is actually cloud cowork? How does this work? How can you connect all these things? Like, I first would have to tell them this. And then get them there to actually do the automations as well, which is then, like, only a really like, like, it's it's easy to do. Like, I saw it how you how how you did it. It makes sense. You just probably take slash deploy skill and then you have your automation deployed.  
Me: Yeah. Right. One one thing about the the  
Them: Okay.  
Me: challenge for Anthropic because we talked about this before. Our hypothesis is that agents will be like, this tool has to be agent agnostic.  
Them: Yep.  
Me: Because Cloudflord will not be the winner forever. Like, some people are using codecs, some people are using other tools. So it's very difficult for OpenAI or Anthropic actually to win it.  
Them: Like, my hypothesis will  
Me: That's our hypothesis.  
Them: my hypothesis would be I get get yours. Like, from a user perspective, yes, but only from a really, really, like, technical focused user. If I would already have five automations, in, cloud in, like, my cloud code, this would be actually a moat for them. Right? So I would really want to build up that mode so it's not that easy anymore to switch.  
Me: Alright.  
Them: Like, from the open source or, like, like not like, the typical guy, the typical dev guy would be like, man, I don't want to be bound to this or this service. I definitely use a tool like this. But the standard business guy is like, man, I'm not gonna switch now. It works for me. It's fine. Yeah. If it costs 20 or $40 a month or, like, maybe 100 later on, honestly, I don't care. I don't wanna do all of this shit ever again. Right? So I as as a from a product perspective, I would really want to build this in my product. And have people bound to me. But I get you. I bought this. You know? Like,  
Me: Yeah.  
Them: yeah. Like, it's you know, it's a bit like how how is this cloud code alternative called OpenCode?  
Me: Open code. Yes. I've used it before.  
Them: Was it OpenCode? Or yeah. Yeah. Yeah. It's, like, the same, like, CloudCode and OpenCode. Like, both both makes sense. Right? But, like, it's different types users. And I just wonder if the business guy is that guy who really wants to be like, okay. Need it needs to be platform agnostic or if it's the more coder guy. The more colder guy, he can do it himself. You know? Just but this is my my just my thoughts. Like, you guys are wrong.  
Me: Bueno, las dos son las de una extensión.  
Them: Okay. No. Got it, guys.  
Me: Nice. Yeah. Cool. Thanks for sharing your, like, how how you work. That's that's very cool to learn. Yeah.  
Them: Awesome. Guys, then? I wish you best of luck. Love to meet you guys. See you.  
Me: Have a great Easter. Great weekend. Bye bye. So, yeah, he he already, like, has 
