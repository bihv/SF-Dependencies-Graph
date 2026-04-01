import itemCmp from "c/orderItem";
import getOrders from "@salesforce/apex/OrderController.getOrders";
import titleLabel from "@salesforce/label/c.Order_Title";
import amountField from "@salesforce/schema/Invoice__c.Amount__c";
import configType from "@salesforce/schema/App_Config__mdt";

export default class OrderSummary {}
