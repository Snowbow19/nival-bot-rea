window.GROK_UI = {
  appName: "Nival Bot",
  userName: "Nival",
  language: "zh-CN",
  theme: "light",
  featureGates: {
    sand_grok_main_agent: true,
    sand_simplified_right_pane: true,
    sand_new_connect_button: true,
    sand_bot_color_theming: true,
  },
  bots: [
    {
      id: "local-assistant",
      name: "助理",
      description: "一起把想法变成行动。",
      avatarColor: "black",
    },
    {
      id: "local-designer",
      name: "原型设计师",
      description: "从一个想法，到一个可以使用的产品。",
      avatarColor: "blue",
    },
    {
      id: "local-writer",
      name: "写作伙伴",
      description: "找到你的表达，让每一句话更清楚。",
      avatarColor: "purple",
    },
    {
      id: "local-research",
      name: "研究助理",
      description: "整理资料，连接观点，形成自己的判断。",
      avatarColor: "green",
    },
  ],
  pinnedBotIds: ["local-assistant", "local-designer"],
  sections: [
    {
      id: "personal",
      name: "我的 Bot",
      agentIds: ["local-writer", "local-research"],
    },
  ],
};
